# dpi-product. Recipes are grouped by work area under just/<group>/mod.just.
# Device recipes take an id from dpi-network.yaml; nothing here names a machine.
set dotenv-load := true
set shell := ["zsh", "-cu"]

# Devices: up, deploy, status, logs, restart
mod net 'just/net'

# This machine's backend
mod backend 'just/backend'

# Web UI hub on port 4781
mod hub 'just/hub'

# Terminal client for one device
mod tui 'just/tui'

# Desktop notifications for one device
mod watch 'just/watch'

# Public door for chat mentions, as signed hook calls on one device
mod bridge 'just/bridge'

# Unit, UI, device and e2e suites
mod test 'just/test'

# List command groups
default:
    @just --list

# Install dependencies for every network app
install:
    cd apps/sdk && npm install --no-audit --no-fund
    cd apps/backend && npm install --no-audit --no-fund
    cd apps/hub && npm install --no-audit --no-fund
    cd apps/tui && npm install --no-audit --no-fund
    cd apps/watch && npm install --no-audit --no-fund
    cd apps/bridge && npm install --no-audit --no-fund

# Type checks and unit tests, every app
check: test::unit
