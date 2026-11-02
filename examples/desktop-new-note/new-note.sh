#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: VAULT=/path/to/vault new-note TITLE [BODY]" >&2
  exit 2
}

vault=${VAULT:-}
title=${1:-}
body=${2-}
if [[ -z $vault || -z $title ]]; then
  usage
fi
template=${TEMPLATE:-$vault/template.typ}
if [[ ! -f $template ]]; then
  echo "template not found: $template" >&2
  exit 1
fi

TEMPLATE=$template perl -0777 -ne '
  my $found = 0;
  while (/\{\{([^{}]*)\}\}/g) {
    my $field = $1;
    die "template placeholder {{$field}} is not supported; use {{title}} and {{body}}\n"
      unless $field eq "title" || $field eq "body";
    $found = 1 if $field eq "title";
  }
  die "template must include {{title}}\n" unless $found;
' "$template"

escaped=$(
  TITLE=$title perl -CS -MEncode=decode -e '
    my $title = decode("UTF-8", $ENV{TITLE}, 1);
    $title =~ s/^\s+|\s+$//g;
    die "give the note a title\n" unless length $title;
    die "title contains path or filename punctuation\n"
      if $title =~ m{[/\\:*?"<>|\p{Cc}]} || $title =~ /^\./;
    $title =~ s/([\\#\[\]*_\$@<>`~])/\\$1/g;
    print $title;
  '
)

filename=$(
  TITLE=$title perl -CS -MEncode=decode,encode -MUnicode::Normalize=NFC -e '
    my $name = NFC(decode("UTF-8", $ENV{TITLE}, 1));
    $name =~ s/^\s+|\s+$//g;
    $name = lc $name;
    $name =~ s/\.typ$//;
    $name =~ s/\s+/_/g;
    die "use a title without a trailing period\n" if $name =~ /\.$/;
    die "use a shorter title\n" if length(encode("UTF-8", $name)) > 180;
    print "$name.typ";
  '
)

destination=$vault/$filename
set -o noclobber
TITLE=$escaped BODY=$body perl -CSD -MEncode=decode -0777 -pe '
  BEGIN {
    $title = decode("UTF-8", $ENV{TITLE}, 1);
    $body = decode("UTF-8", $ENV{BODY}, 1);
    $body =~ s/\s+\z//;
  }
  s/\{\{(title|body)\}\}/$1 eq "title" ? $title : $body/ge;
' "$template" > "$destination"
echo "$destination"
