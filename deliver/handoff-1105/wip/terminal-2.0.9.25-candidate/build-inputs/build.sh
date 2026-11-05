#!/bin/sh
# Rebuilds from this folder alone (node 18+; no install, no network): sh build.sh 2.0.9.25 | 2.0.9.24 | 2.0.9.16 | 2.0.9.13 | 2.0.9.12 | 2.0.9.11 | 2.0.9.10 | 2.0.9.9 | 2.0.9.8 | 2.0.9.7 | 2.0.9.6
# Prints the page's sha256 (compare with ../SHA256SUMS) and the build ID (the first 8 hex of the sha256 of the input manifest).
set -e; V=${1:-2.0.9.25}; cd "$(dirname "$0")/macui/harness"; MOD=sp,charts,reactor,reel,radarbg,clpath
case $V in
  2.0.9.25) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20925.cjs >/dev/null ;;
  2.0.9.24) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20924.cjs >/dev/null ;;
  2.0.9.23) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20923.cjs >/dev/null ;;
  2.0.9.22) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20922.cjs >/dev/null ;;
  2.0.9.21) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20921.cjs >/dev/null ;;
  2.0.9.20) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20920.cjs >/dev/null ;;
  2.0.9.19.2) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-201992.cjs >/dev/null ;;
  2.0.9.19) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20919.cjs >/dev/null ;;
  2.0.9.18) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20918.cjs >/dev/null ;;
  2.0.9.17) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20917.cjs >/dev/null ;;
  2.0.9.16) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20916.cjs >/dev/null ;;
  2.0.9.13) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20913.cjs >/dev/null ;;
  2.0.9.12) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20912.cjs >/dev/null ;;
  2.0.9.11) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20911.cjs >/dev/null ;;
  2.0.9.10) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-20910.cjs >/dev/null ;;
  2.0.9.9|2.0.9.8|2.0.9.7|2.0.9.6) env MACUI_BRAIN=bv MACUI_BASE=r133 MACUI_MODULES=$MOD MACUI_RELEASE=$V MACUI_REEL_NUMBERS=labelled MACUI_OUT=../../mobile.rebuilt-$V.html node build-2099.cjs >/dev/null ;;
  *) echo "unknown variant $V"; exit 1 ;; esac
cd ../..; sha256sum mobile.rebuilt-$V.html; echo "build ID $(sha256sum mobile.rebuilt-$V.html.inputs.txt | cut -c1-8) (= sha256 of the input manifest)"
