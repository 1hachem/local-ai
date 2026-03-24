# local-ai

CLI helper to run AI agent chat loops and workflows over TCP/Unix sockets.

## Usage

### With npm

```bash
# Start the server
npm run server

# In another terminal, connect with the client
npm run client
```

### With raw TCP/Unix sockets

Server in TCP mode:
```bash
echo "hello hi" | nc localhost 3005
```

Server in socket mode:
```bash
echo "hello hi" | nc -U /tmp/local-ai.socket
```

### With Nix

```bash
# Build
nix build

# Run directly
nix run . -- server --framework vercel --port 3005
nix run . -- client --port 3005
```

## NixOS integration

The flake exposes a NixOS module that runs the server as a systemd service and provides the CLI.

### 1. Add the flake input

```nix
# flake.nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # ... your other inputs ...
  local-ai.url = "github:1hachem/local-ai";
};
```

### 2. Import the module

```nix
# flake.nix outputs
outputs = { nixpkgs, local-ai, ... }: {
  nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      ./configuration.nix
      local-ai.nixosModules.default
    ];
    specialArgs = { inherit local-ai; };
  };
};
```

### 3. Configure the service and CLI

```nix
# configuration.nix
{ pkgs, local-ai, ... }:
{
  # Systemd service -- starts the server on boot
  services.local-ai = {
    enable = true;
    framework = "vercel";
    port = 3005;
    # socket = "/run/local-ai/local-ai.sock";       # Unix socket (can use both)
    environmentFile = "/run/secrets/local-ai.env";   # file containing OPENROUTER_API_KEY=sk-...
  };

  # CLI available system-wide
  environment.systemPackages = [
    local-ai.packages.${pkgs.stdenv.hostPlatform.system}.local-ai
  ];
}
```

### 4. Create the secrets file

The server needs `OPENROUTER_API_KEY` at runtime:

```bash
# /run/secrets/local-ai.env
OPENROUTER_API_KEY=sk-or-v1-...
```

If you use `sops-nix` or `agenix`, point `environmentFile` to the decrypted secret path.

### 5. Rebuild and use

```bash
sudo nixos-rebuild switch --flake .#myhost

# Server is running as a systemd service
systemctl status local-ai
journalctl -u local-ai -f

# Connect with the client
local-ai client --port 3005
```

### Module options

| Option | Type | Default | Description |
|---|---|---|---|
| `services.local-ai.enable` | bool | `false` | Enable the systemd service |
| `services.local-ai.framework` | string | `"vercel"` | AI framework adapter |
| `services.local-ai.port` | port or null | `3005` | TCP port (null to disable) |
| `services.local-ai.socket` | string or null | `null` | Unix socket path |
| `services.local-ai.environmentFile` | path or null | `null` | Env file with secrets |
| `services.local-ai.package` | package | (from flake) | Override the local-ai package |

## Roadmap

- define agents in different frameworks:
    - ai sdk from vercel
    - volt agent
    - hyko
    - workflows with trigger.dev
    - opencode?

- lego modules for:
    - context compression
    - k8s mcp deployment

- give agents different tools, mcps, reference to other agents
- local agent discovery and handshakes
- persistent inter-agent sessions (in-memory, json file, postgres)
- expose these agents for IPC either via UNIX sockets or tcp loop back
- pick up chat from previous sessions
- create cli pipes with agents in the middle (to cat files in the middle, use variables ...)

### NixOS integration goals (useful for cloud deployment of workspaces)
- nix derivation to declare these agents as systemd services
- wake agents via socket based activations
- jailed systemd service with minimal access to commands and file-system
- use systemd credentials and gnu pass to manage passwords and envs
- journalctl logs on whole workspace for visibility and event driven actions

## TODO
- [x] use cmd-ts for client cli
- [x] add nixos derivation to run the server as systemd and the client cli
- [ ] add option to continue from sessionId
