# watch, desktop notifications for one device. Banners only when a person is needed.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/watch"

# List notification commands
[default]
default:
    @just --list watch

# Follow a device (default: the first registered one); args pass straight through
follow *ARGS:
    npm start --silent -- "$@"

# Type check and run the watcher tests
check:
    npm run check
    npm test
