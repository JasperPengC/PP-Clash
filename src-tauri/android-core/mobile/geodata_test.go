package mobile

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func fixtureGeodata(t *testing.T, corrupt bool) ([]byte, map[string][]byte) {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	manifest := map[string]geoEntry{}
	data := map[string][]byte{}
	for _, name := range geoNames {
		data[name] = []byte("verified fixture: " + name)
		digest := sha256.Sum256(data[name])
		manifest[name] = geoEntry{SHA256: hex.EncodeToString(digest[:]), Size: int64(len(data[name]))}
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		content := data[name]
		if corrupt {
			content = []byte("corrupt")
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	entry, err := archive.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(entry).Encode(manifest); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), data
}

func TestGeodataRepairsMissingCorruptAndLegacyFiles(t *testing.T) {
	bundle, expected := fixtureGeodata(t, false)
	dir := t.TempDir()
	cache := make(map[string]os.FileInfo)
	legacy := filepath.Join(dir, "GeoSite.dat")
	if err := os.WriteFile(legacy, []byte("partial previous download"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Country.mmdb"), []byte("old database"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installGeodata(dir, bundle, cache); err != nil {
		t.Fatal(err)
	}
	for name, content := range expected {
		path := geodataPath(dir, name)
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(content, actual) {
			t.Fatalf("%s was not prepared", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "geosite.dat")); err == nil && legacy != geodataPath(dir, "geosite.dat") {
		t.Fatal("legacy filename was duplicated")
	}
	before, _ := os.Stat(legacy)
	if err := installGeodata(dir, bundle, cache); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(legacy)
	if !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("unchanged data was rewritten")
	}
	// A same-size corrupt file must also be repaired, including after a process restart.
	if err := os.WriteFile(legacy, bytes.Repeat([]byte("x"), len(expected["geosite.dat"])), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(legacy)
	if !bytes.Equal(actual, expected["geosite.dat"]) {
		t.Fatal("same-size corruption survived")
	}
}

func TestGeodataBadArchivePreservesExistingFiles(t *testing.T) {
	bundle, _ := fixtureGeodata(t, true)
	dir := t.TempDir()
	path := filepath.Join(dir, "geoip.metadb")
	previous := []byte("previous database")
	if err := os.WriteFile(path, previous, 0600); err != nil {
		t.Fatal(err)
	}
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err == nil {
		t.Fatal("accepted corrupt archive")
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(previous, actual) {
		t.Fatal("corrupt data replaced the previous file")
	}
	stages, _ := filepath.Glob(filepath.Join(dir, ".geodata-*"))
	if len(stages) != 0 {
		t.Fatal("temporary files were leaked")
	}
}

// Run each mode in its own process: mihomo keeps geodata initialization globally.
func TestValidateOfflineGeodata(t *testing.T) {
	mode := os.Getenv("PPCLASH_TEST_GEODATA_MODE")
	if mode == "" {
		for _, name := range []string{"db", "dat"} {
			t.Run(name, func(t *testing.T) {
				cmd := exec.Command(os.Args[0], "-test.run=^TestValidateOfflineGeodata$")
				cmd.Env = append(os.Environ(), "PPCLASH_TEST_GEODATA_MODE="+name)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("fresh installation cannot validate offline: %v\n%s", err, output)
				}
			})
		}
		return
	}
	var requests atomic.Int32
	unavailable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "offline", http.StatusServiceUnavailable)
	}))
	defer unavailable.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "candidate.yaml")
	content := fmt.Sprintf(`geodata-mode: %t
geo-auto-update: false
geox-url:
  geoip: %s/geoip.dat
  mmdb: %s/geoip.metadb
  geosite: %s/geosite.dat
  asn: %s/ASN.mmdb
rules:
  - GEOIP,CN,DIRECT
  - GEOSITE,cn,DIRECT
  - IP-ASN,13335,DIRECT
  - MATCH,DIRECT
dns:
  enable: true
  nameserver: [1.1.1.1]
  nameserver-policy:
    "geosite:geolocation-!cn": [1.1.1.1]
    "geosite:cn,private": [223.5.5.5]
`, mode == "dat", unavailable.URL, unavailable.URL, unavailable.URL, unavailable.URL)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Validate(path); err != nil {
		t.Fatalf("validation failed: %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("geodata made %d network requests", requests.Load())
	}
}
