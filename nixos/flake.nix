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
            {boot.isNspawnContainer = true;}
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
              boot.loader.grub.device = "nodev";
            }
          ];
      };
    };
  };
}
