package ashurbanipal

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
)

//go:embed frontend/dbviewer.html
var frontendFS embed.FS

// pinnedFrontendSHA256 mirrors the Spring Boot starter's build.gradle.kts
// vendorFrontend task and PORTING.md's vendoring contract: a build
// pipeline can silently mangle the vendored file, so the hash is
// re-verified on every build (init, here), not just recorded once at
// vendoring time. It pins the sha256 of this repo's canonical
// frontend/dbviewer.html — there is no separately published frontend artifact.
const pinnedFrontendSHA256 = "0b9184927257a6010abf65c3e5957a0df400c3b0bdd79c772df86815c60740be"

var dbviewerHTML = mustLoadFrontend()

func mustLoadFrontend() []byte {
	bytes, err := frontendFS.ReadFile("frontend/dbviewer.html")
	if err != nil {
		panic(fmt.Sprintf("ashurbanipal: embedded frontend/dbviewer.html missing: %v", err))
	}
	sum := sha256.Sum256(bytes)
	actual := hex.EncodeToString(sum[:])
	if actual != pinnedFrontendSHA256 {
		panic(fmt.Sprintf(
			"ashurbanipal: frontend/dbviewer.html sha256 mismatch: expected %s, got %s "+
				"(the vendored frontend changed upstream — re-pin deliberately, don't silently accept a mangled copy)",
			pinnedFrontendSHA256, actual))
	}
	return bytes
}
