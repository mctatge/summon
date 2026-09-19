#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fn_tap_detector.h"

enum { FUNCTION_KEY = 0x3F }; /* kVK_Function in HIToolbox/Events.h. */
static const CGEventFlags chord_modifiers = kCGEventFlagMaskShift | kCGEventFlagMaskControl
    | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand | kCGEventFlagMaskHelp;
static FnTapDetector detector;
static CFMachPortRef event_tap;
/* Keys the tap itself has seen go down and not yet come up. The system's combined key state cannot be
   trusted for this: on some Macs it reports a key (keycode 0 was observed) as held forever, which made
   every Fn tap look like a chord. Keys held since before startup are the accepted blind spot. */
static uint8_t keys_down[32];
static void keys_clear(void) { memset(keys_down, 0, sizeof keys_down); }
static void key_set(CGKeyCode key, bool down) {
    if (key >= 256) return;
    if (down) keys_down[key / 8] |= (uint8_t)(1u << (key % 8)); else keys_down[key / 8] &= (uint8_t)~(1u << (key % 8));
}
static bool any_key_down(void) {
    for (size_t i = 0; i < sizeof keys_down; i++) if (keys_down[i]) return true;
    return false;
}

static bool function_is_down(void) {
    return (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)
            & kCGEventFlagMaskSecondaryFn) != 0;
}

static void reset_detector(void) {
    keys_clear();
    fn_tap_reset(&detector, function_is_down());
}

static CGEventRef handle_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy;
    (void)context;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        reset_detector();
        if (!CGPreflightListenEventAccess()) {
            puts("{\"type\":\"permission-required\"}");
            CFRunLoopStop(CFRunLoopGetMain());
        } else {
            CGEventTapEnable(event_tap, true);
        }
        return event;
    }
    if (type != kCGEventFlagsChanged) {
        if (type == kCGEventKeyDown || type == kCGEventKeyUp)
            key_set((CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode), type == kCGEventKeyDown);
        fn_tap_other_input(&detector);
        return event;
    }

    const bool is_function_key = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == FUNCTION_KEY;
    const CGEventFlags flags = CGEventGetFlags(event);
    const bool other_key_is_down = is_function_key && any_key_down();
    if (fn_tap_flags_changed(&detector, is_function_key,
            (flags & kCGEventFlagMaskSecondaryFn) != 0,
            (flags & chord_modifiers) != 0, other_key_is_down)) {
        puts("{\"type\":\"fn-tap\"}");
    }
    return event;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    const bool request_permission = argc == 2 && strcmp(argv[1], "--request-permission") == 0;
    if (argc != 1 && !request_permission) {
        puts("{\"type\":\"error\",\"message\":\"Unsupported Fn shortcut helper arguments.\"}");
        return 64;
    }
    if (request_permission) {
        const bool allowed = CGPreflightListenEventAccess() || CGRequestListenEventAccess();
        puts(allowed ? "{\"type\":\"permission-granted\"}" : "{\"type\":\"permission-required\"}");
        return allowed ? 0 : 77;
    }
    if (!CGPreflightListenEventAccess()) {
        puts("{\"type\":\"permission-required\"}");
        return 77;
    }

    reset_detector();
    const CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged)
        | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp)
        | CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventRightMouseDown)
        | CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventScrollWheel)
        | CGEventMaskBit(14);
    event_tap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap,
        kCGEventTapOptionListenOnly, mask, handle_event, NULL);
    if (event_tap == NULL) {
        puts("{\"type\":\"error\",\"message\":\"macOS could not start the Fn shortcut monitor.\"}");
        return 1;
    }
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, event_tap, 0);
    if (source == NULL) {
        puts("{\"type\":\"error\",\"message\":\"macOS could not create the Fn shortcut event source.\"}");
        CFRelease(event_tap);
        return 1;
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(event_tap, true);

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        char command[64];
        while (fgets(command, sizeof(command), stdin) != NULL) {
            if (strcmp(command, "reset\n") != 0) continue;
            CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{ reset_detector(); });
            CFRunLoopWakeUp(CFRunLoopGetMain());
        }
        CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{ CFRunLoopStop(CFRunLoopGetMain()); });
        CFRunLoopWakeUp(CFRunLoopGetMain());
    });

    puts("{\"type\":\"ready\"}");
    CFRunLoopRun();
    CGEventTapEnable(event_tap, false);
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CFMachPortInvalidate(event_tap);
    CFRelease(source);
    CFRelease(event_tap);
    return 0;
}
