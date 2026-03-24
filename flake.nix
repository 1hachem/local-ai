{
  description = "local-ai – CLI to run AI agent chat loops over TCP/Unix sockets";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};

        local-ai = pkgs.buildNpmPackage {
          pname = "local-ai";
          version = "1.0.0";

          src = ./.;

          npmDepsHash = "sha256-ildNtYuXejHbAdJFgQYgrTAqr9Sgw0Crq9jvci4gatI=";

          nativeBuildInputs = [pkgs.esbuild pkgs.makeWrapper];

          # Skip esbuild's postinstall script that validates the binary version.
          # We use the nixpkgs esbuild directly in the build phase instead.
          npmFlags = ["--ignore-scripts"];
          dontNpmBuild = true;

          # Call esbuild from nixpkgs directly (bypasses the npm esbuild package entirely)
          buildPhase = ''
            runHook preBuild
            esbuild src/cli.ts \
              --bundle \
              --platform=node \
              --format=esm \
              --outfile=dist/cli.js \
              "--banner:js=#!/usr/bin/env node" \
              --packages=external
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/local-ai $out/bin

            cp -r dist $out/lib/local-ai/
            cp -r node_modules $out/lib/local-ai/
            cp package.json $out/lib/local-ai/

            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/local-ai \
              --add-flags "$out/lib/local-ai/dist/cli.js" \
              --set NODE_PATH "$out/lib/local-ai/node_modules"
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "CLI helper to run AI framework chat loops and workflows";
            license = licenses.isc;
            mainProgram = "local-ai";
          };
        };
      in {
        packages = {
          default = local-ai;
          local-ai = local-ai;
        };
      }
    )
    // {
      nixosModules.default = {
        config,
        lib,
        pkgs,
        ...
      }: let
        cfg = config.services.local-ai;
        localAiPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.local-ai;
      in {
        options.services.local-ai = {
          enable = lib.mkEnableOption "local-ai server";

          package = lib.mkOption {
            type = lib.types.package;
            default = localAiPkg;
            description = "The local-ai package to use.";
          };

          framework = lib.mkOption {
            type = lib.types.str;
            default = "vercel";
            description = "AI framework adapter to use (e.g. vercel).";
          };

          port = lib.mkOption {
            type = lib.types.nullOr lib.types.port;
            default = 3005;
            description = "TCP port to listen on. Set to null to disable.";
          };

          socket = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = "/run/local-ai/local-ai.sock";
            description = "Unix domain socket path to listen on. Set to null to disable.";
          };

          environmentFile = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = ''
              Path to an environment file containing secrets (e.g. OPENROUTER_API_KEY).
              The file should contain lines like: OPENROUTER_API_KEY=sk-...
            '';
          };
        };

        config = lib.mkIf cfg.enable {
          assertions = [
            {
              assertion = cfg.port != null || cfg.socket != null;
              message = "services.local-ai: at least one of port or socket must be set.";
            }
          ];

          systemd.services.local-ai = {
            description = "local-ai NDJSON server";
            after = ["network.target"];
            wantedBy = ["multi-user.target"];

            serviceConfig =
              {
                Type = "simple";
                DynamicUser = true;
                ExecStart = let
                  args =
                    ["${cfg.package}/bin/local-ai" "server" "--framework" cfg.framework]
                    ++ lib.optionals (cfg.port != null) ["--port" (toString cfg.port)]
                    ++ lib.optionals (cfg.socket != null) ["--socket" cfg.socket];
                in
                  lib.concatStringsSep " " args;
                Restart = "on-failure";
                RestartSec = 5;

                # Hardening
                NoNewPrivileges = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
              }
              // lib.optionalAttrs (cfg.environmentFile != null) {
                EnvironmentFile = cfg.environmentFile;
              }
              // lib.optionalAttrs (cfg.socket != null) {
                RuntimeDirectory = "local-ai";
              };
          };
        };
      };
    };
}
