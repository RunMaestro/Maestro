{
  description = "Maestro development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            git
            # Native module compilation (node-gyp needs python with setuptools)
            (python3.withPackages (ps: [ ps.setuptools ]))
            pkg-config
          ];

          shellHook = ''
            echo "Maestro dev environment loaded (Node.js $(node --version))" >&2
          '';
        };
      });
}
