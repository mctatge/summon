#ifndef SUMMON_FN_TAP_DETECTOR_H
#define SUMMON_FN_TAP_DETECTOR_H
#include <stdbool.h>

typedef struct {
    bool fn_is_down;
    bool eligible;
} FnTapDetector;

static inline void fn_tap_reset(FnTapDetector *detector, bool fn_is_down) {
    detector->fn_is_down = fn_is_down;
    detector->eligible = false;
}

static inline void fn_tap_other_input(FnTapDetector *detector) {
    detector->eligible = false;
}

static inline bool fn_tap_flags_changed(
    FnTapDetector *detector, bool is_function_key, bool fn_is_down,
    bool other_modifier_is_down, bool other_key_is_down
) {
    const bool was_down = detector->fn_is_down;
    detector->fn_is_down = fn_is_down;
    if (!is_function_key) {
        detector->eligible = false;
        return false;
    }
    if (fn_is_down) {
        if (!was_down) {
            detector->eligible = !other_modifier_is_down && !other_key_is_down;
        } else if (other_modifier_is_down || other_key_is_down) {
            detector->eligible = false;
        }
        return false;
    }
    const bool trigger = was_down && detector->eligible
        && !other_modifier_is_down && !other_key_is_down;
    detector->eligible = false;
    return trigger;
}
#endif
