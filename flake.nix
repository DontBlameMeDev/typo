{
  description = "Typo Android development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    flake-utils,
    git-hooks,
    ...
  }:
    flake-utils.lib.eachSystem ["x86_64-linux"] (system: let
      pkgs = import nixpkgs {inherit system;};

      inherit (pkgs) bun;
      node = pkgs.nodejs_24;
      dependencies = pkgs.stdenvNoCC.mkDerivation {
        name = "typo-dependencies";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [./package.json ./bun.lock];
        };
        nativeBuildInputs = [bun pkgs.cacert];
        dontConfigure = true;
        dontBuild = true;
        dontFixup = true;
        installPhase = ''
          export HOME=$(mktemp -d)
          bun install --frozen-lockfile --ignore-scripts
          mkdir -p $out
          cp -r node_modules $out/
        '';
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-6dgxQoyATwBO3BRRsArlM5DH1tG9qwTjeV31D+yy2uo=";
      };
      check = name: command:
        pkgs.runCommand name {nativeBuildInputs = [bun node];} ''
          cp -r ${pkgs.lib.cleanSource ./.} source
          chmod -R u+w source
          cd source
          ln -s ${dependencies}/node_modules node_modules
          ${command}
          touch $out
        '';

      mkHook = name: entry: {
        enable = true;
        inherit name entry;
        language = "system";
        pass_filenames = false;
      };

      hooks = git-hooks.lib.${system}.run {
        src = pkgs.lib.cleanSource ./.;
        excludes = ["^android/" "^ios/" "^bun.lock$"];

        hooks = {
          alejandra.enable = true;
          deadnix.enable = true;
          flake-checker.enable = true;
          gitlint.enable = true;
          check-merge-conflicts.enable = true;
          forbid-new-submodules.enable = true;
          check-json.enable = true;
          lychee = {
            enable = true;
            types = ["markdown"];
            settings.flags = "--offline";
          };
          comrak = {
            enable = true;
            entry = "${pkgs.comrak}/bin/comrak --inplace --extension tasklist";
          };
          ripsecrets.enable = true;
          typos.enable = true;
          check-toml.enable = true;
          check-yaml.enable = true;
          check-executables-have-shebangs.enable = true;
          check-shebang-scripts-are-executable.enable = true;
          check-added-large-files.enable = true;
          check-symlinks.enable = true;
          trim-trailing-whitespace.enable = true;
          shellcheck.enable = true;

          woodpecker-cli-lint = {
            enable = true;
            files = "\\.woodpecker/";
          };

          biome.enable = true;
          html-tidy.enable = true;

          typecheck =
            mkHook "tsc"
            "${bun}/bin/bun node_modules/typescript/bin/tsc --noEmit";

          test =
            mkHook "bun test"
            "${bun}/bin/bun test";
        };
      };
    in {
      formatter = pkgs.alejandra;

      checks = {
        pre-commit = hooks.overrideAttrs (old: {
          buildPhase =
            ''
              ln -s ${dependencies}/node_modules node_modules
              export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            ''
            + old.buildPhase;
        });
        typecheck = check "typo-typecheck" "bun node_modules/typescript/bin/tsc --noEmit";
        test = check "typo-test" "bun test";
      };

      devShells.default = pkgs.mkShell {
        packages =
          [
            bun
            node
            pkgs.typescript
            pkgs.biome
            pkgs.jdk21
          ]
          ++ hooks.enabledPackages;

        NODE_ENV = "development";
        JAVA_HOME = pkgs.jdk21.home;

        shellHook =
          hooks.shellHook
          + ''
            export ANDROID_HOME="''${ANDROID_HOME:-$HOME/Android/Sdk}"
            export ANDROID_SDK_ROOT="$ANDROID_HOME"
            export PATH="$ANDROID_HOME/platform-tools:$PATH"
          '';
      };

      apps.default = {
        type = "app";
        meta.description = "Start the Typo Expo development server";
        program = "${pkgs.writeShellScriptBin "app" ''
          exec ${pkgs.bun}/bin/bun run dev "$@"
        ''}/bin/app";
      };
    });
}
