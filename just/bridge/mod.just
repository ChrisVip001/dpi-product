# bridge, the public door for chat mentions (Feishu today). Reads apps/bridge/bridge.yaml.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/bridge"

# List bridge commands
[default]
default:
    @just --list bridge

# Run the bridge
run *ARGS:
    npm start --silent -- "$@"

# Type check and run the bridge tests
check:
    npm run check
    npm test
