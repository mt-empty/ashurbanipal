package ashurbanipal

import (
	"encoding/json"
	"fmt"
)

// keyShape lists an object's allowed keys and, for each, the shape of its
// value (nil for a value with no keys to check). An array's elements share
// the shape the array was given.
type keyShape map[string]keyShape

// checkKeys rejects any key the shape does not list, matching case exactly:
// encoding/json matches struct fields case-insensitively, so
// DisallowUnknownFields alone accepts `TABLE` for `table`.
func checkKeys(raw string, shape keyShape) error {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return nil // the typed decode reports malformed JSON
	}
	return walkKeys(v, shape)
}

func walkKeys(v any, shape keyShape) error {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			sub, ok := shape[k]
			if !ok {
				return fmt.Errorf("unknown key %q", k)
			}
			if sub != nil {
				if err := walkKeys(val, sub); err != nil {
					return err
				}
			}
		}
	case []any:
		for _, e := range t {
			if err := walkKeys(e, shape); err != nil {
				return err
			}
		}
	}
	return nil
}
