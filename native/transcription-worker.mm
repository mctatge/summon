// Private stdio-only Whisper worker. No microphone, sockets, files or transcripts
// are opened/written here apart from the explicitly selected model at startup.
#import <Foundation/Foundation.h>
#include <whisper.h>
#include <ggml-backend.h>
#include <chrono>
#include <csignal>
#include <cmath>
#include <iostream>
#include <vector>
#ifndef SUMMON_WHISPER_VERSION
#define SUMMON_WHISPER_VERSION "1.9.1"
#endif

static volatile sig_atomic_t stopping = 0;
static void terminate(int) { stopping = 1; }
static void quietLog(enum ggml_log_level level, const char *message, void *) {
    if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) fputs(message, stderr);
}
static bool abortDecode(void *) { return stopping != 0; }
static void emit(NSDictionary *message) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static double milliseconds(std::chrono::steady_clock::time_point start) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-start).count();
}
static whisper_full_params parameters() {
    auto p = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    p.n_threads = 4;
    p.no_context = true;
    p.no_timestamps = true;
    p.print_special = p.print_progress = p.print_realtime = p.print_timestamps = false;
    p.language = "en";
    p.detect_language = false;
    p.initial_prompt = "Summon. Calendar. Excel workbook.";
    p.greedy.best_of = 5;
    p.beam_search.beam_size = 5;
    p.temperature = 0;
    p.temperature_inc = 0.2f;
    p.abort_callback = abortDecode;
    return p;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) { std::cerr << "Expected an absolute local Whisper model path.\n"; return 2; }
        if (strcmp(whisper_version(), SUMMON_WHISPER_VERSION) != 0) {
            std::cerr << "Whisper runtime changed. Rebuild Summon's transcription helper for the installed version.\n"; return 2;
        }
        signal(SIGTERM, terminate); signal(SIGINT, terminate); signal(SIGPIPE, SIG_IGN);
        whisper_log_set(quietLog, nullptr);
        ggml_log_set(quietLog, nullptr);
        const auto start = std::chrono::steady_clock::now();
        if (getenv("SUMMON_TRANSCRIPTION_DEBUG")) std::cerr << "Preparing GPU backend and shader cache.\n";
        ggml_backend_load_all();
        if (getenv("SUMMON_TRANSCRIPTION_DEBUG")) std::cerr << "Backend initialized in " << milliseconds(start) << " ms.\n";
        const auto modelStart = std::chrono::steady_clock::now();
        auto options = whisper_context_default_params();
        options.use_gpu = true; options.flash_attn = true;
        auto *ctx = whisper_init_from_file_with_params(argv[1], options);
        if (!ctx) { std::cerr << "Could not load the selected local Whisper model.\n"; return 3; }
        if (getenv("SUMMON_TRANSCRIPTION_DEBUG")) std::cerr << "Model initialized in " << milliseconds(modelStart) << " ms.\n";
        // Compile/cache the inference graph during warming, not on first speech.
        std::vector<float> silence(WHISPER_SAMPLE_RATE, 0.0f);
        auto warmParams = parameters();
        warmParams.initial_prompt = nullptr;
        warmParams.greedy.best_of = 1;
        warmParams.single_segment = true;
        warmParams.max_tokens = 1;
        if (whisper_full(ctx, warmParams, silence.data(), static_cast<int>(silence.size())) != 0 || stopping) {
            whisper_free(ctx); std::cerr << "Whisper warm-up did not complete.\n"; return 4;
        }
        if (getenv("SUMMON_TRANSCRIPTION_DEBUG")) std::cerr << "Warm graph finished in " << milliseconds(start) << " ms.\n";
        emit(@{@"type":@"ready", @"runtime":@(whisper_version()), @"warmMs":@(milliseconds(start))});
        std::vector<char> line(3'000'001);
        while (!stopping && std::cin.getline(line.data(), line.size())) {
            @autoreleasepool {
                NSString *requestId = nil;
                try {
                    NSData *json = [NSData dataWithBytes:line.data() length:strlen(line.data())];
                    id request = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
                    if (![request isKindOfClass:NSDictionary.class]) throw std::runtime_error("Invalid transcription request.");
                    requestId = request[@"id"];
                    NSString *encoded = request[@"pcm"];
                    if (![requestId isKindOfClass:NSString.class] || requestId.length > 100 || ![encoded isKindOfClass:NSString.class]) throw std::runtime_error("Invalid transcription request.");
                    NSData *pcm = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
                    if (!pcm || pcm.length % sizeof(float) || pcm.length < 1600*sizeof(float) || pcm.length > 480000*sizeof(float)) throw std::runtime_error("Audio must contain 0.1–30 seconds of mono 16 kHz PCM.");
                    const auto *samples = static_cast<const float *>(pcm.bytes);
                    const int count = static_cast<int>(pcm.length/sizeof(float));
                    double energy = 0;
                    for (int i=0; i<count; ++i) {
                        if (!std::isfinite(samples[i]) || fabs(samples[i])>1.01f) throw std::runtime_error("Invalid PCM audio values.");
                        energy += samples[i]*samples[i];
                    }
                    const auto began = std::chrono::steady_clock::now();
                    std::string text;
                    if (sqrt(energy/count) >= 0.001) {
                        auto params = parameters();
                        if (whisper_full(ctx, params, samples, count) != 0 || stopping) throw std::runtime_error("Local transcription was cancelled or failed.");
                        for (int i=0; i<whisper_full_n_segments(ctx); ++i) {
                            const char *part = whisper_full_get_segment_text(ctx, i);
                            if (part) text += part;
                            if (text.size() > 16000) throw std::runtime_error("Transcription exceeded the output limit.");
                        }
                    }
                    emit(@{@"id":requestId, @"text":@(text.c_str()), @"decodeMs":@(milliseconds(began))});
                } catch (const std::exception &error) {
                    emit(@{@"id":requestId ?: NSNull.null, @"error":@(error.what())});
                }
            }
        }
        whisper_free(ctx);
        return 0;
    }
}
