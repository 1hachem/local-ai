{
  description = "NixOS container and VM flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    local-ai.url = "path:/home/hachem/local-ai";
  };

  outputs = {
    nixpkgs,
    local-ai,
    ...
  } @ inputs: let
    system = "x86_64-linux";
  in {
    nixosConfigurations = let
      commonModules = [
        local-ai.nixosModules.default
        ({pkgs, ...}: {
          users.groups.humans = {};
          users.groups.agents = {};

          users.users.hachem = {
            group = "humans";
            isSystemUser = true;
            extraGroups = ["wheel" "docker"];
            initialPassword = "hachem";
            shell = pkgs.zsh;
          };

          services.local-ai = {
            enable = true;
            framework = "vercel";
            socket = "/run/local-ai/local-ai.sock";
            environmentFile = "/home/hachem/local-ai/.env";
          };

          environment.systemPackages = [
            local-ai.packages.${system}.local-ai
          ];

          programs.zsh.enable = true;

          services.openssh = {
            enable = true;
            settings = {
              PasswordAuthentication = true;
              KbdInteractiveAuthentication = true;
            };
          };

          system.stateVersion = "25.11";
        })
      ];
    in {
      container = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = {
          inherit inputs;
          inherit system;
        };
        modules =
          commonModules
          ++ [
            {
              boot.isContainer = true;
              networking.firewall.enable = false;
              networking.useHostResolvConf = nixpkgs.lib.mkForce false;

              services.resolved.enable = true;
              nix.settings.experimental-features = ["nix-command" "flakes"];
              nix.settings.sandbox = false; # required without user namespaces
            }
          ];
      };

      vm = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = {
          inherit inputs;
          inherit system;
        };
        modules =
          commonModules
          ++ [
            {
              boot.loader.systemd-boot.enable = true;
              boot.loader.efi.canTouchEfiVariables = true;

              services.xserver.enable = true;
              services.xserver.displayManager.gdm.enable = true;
              services.xserver.desktopManager.gnome.enable = true;

              # Use bridged or user-mode networking with port forwarding
              virtualisation.vmVariant = {
                virtualisation = {
                  # Forward host port 2222 to guest port 22
                  forwardPorts = [
                    {
                      from = "host";
                      host.port = 2222;
                      guest.port = 22;
                    }
                  ];
                };
              };
            }
          ];
      };
    };
  };
}
