package ashurbanipal

import (
	"bytes"
	"compress/gzip"
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
const pinnedFrontendSHA256 = "c2fc9b354c6dc0ec9a3f3cd9be5b0cc9397e6ba2cfc9a90b3139b252be26cedb"

var dbviewerHTML = mustLoadFrontend()

var dbviewerHTMLGzip = gzipPage(dbviewerHTML)

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

// gzipPage ignores errors: a gzip.Writer at a valid level over a bytes.Buffer never returns one.
func gzipPage(page []byte) []byte {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(page)
	_ = zw.Close()
	return buf.Bytes()
}
