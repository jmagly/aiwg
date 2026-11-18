{
  # Development shell for building and testing AIWG under Nix (#4297).
  # `nix develop` provides every external tool the build and default test lanes
  # need; test/unit/dev/nix-dev-shell.test.ts keeps this list in sync.
  description = "AIWG development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            # Runtime and package manager (package.json engines: node >=24).
            nodejs_24
            # Source control and signing: delivery, commit-identity and effect verifier tests.
            git gnupg openssh openssl
            # Scripting used by build, test and release tooling.
            bash python3 coreutils findutils gnugrep gnused gawk gnutar gzip which
            # Optional integration helpers exercised when present.
            tmux
          ] ++ lib.optionals stdenv.isLinux [
            # Process-tree inspection (hang reports, process monitor) and ACL tests.
            procps acl
          ];
          shellHook = ''
            echo "AIWG dev shell: node $(node --version), npm $(npm --version)"
          '';
        };
      });
    };
}
