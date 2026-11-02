{pkgs ? import <nixpkgs> {}}: let
  script = pkgs.writeText "new-note.sh" (builtins.readFile ./new-note.sh);
in
  pkgs.writeShellScriptBin "new-note" ''
    export PATH="${pkgs.perl}/bin:$PATH"
    exec ${pkgs.bash}/bin/bash ${script} "$@"
  ''
