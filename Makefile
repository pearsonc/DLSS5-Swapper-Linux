# The three repository targets. `test` is the fork's Linux run,
# proton-install-core~30~3; `build` installs from the lockfile and never runs a build step.

.PHONY: build test clean

build:
	npm ci

test:
	npm run test:linux

clean:
	rm -rf node_modules
