.PHONY: ci install check build-web check-web check-rust scan build-macos build-macos-release build-windows build-windows-release

ci: install check

install:
	./scripts/ci.sh install

check:
	./scripts/ci.sh check

build-web:
	./scripts/ci.sh build-web

check-web:
	./scripts/ci.sh check-web

check-rust:
	./scripts/ci.sh check-rust

scan:
	./scripts/ci.sh scan

build-macos:
	./scripts/ci.sh build-macos

build-macos-release:
	./scripts/ci.sh build-macos-release

build-windows:
	./scripts/ci.sh build-windows

build-windows-release:
	./scripts/ci.sh build-windows-release
