# Sourced by live-tests.sh (zsh or bash). Decides whether the SEARCH tests, which spend Serper credit, run today.
#
#   search_gate <stamp-file> <every-days>   prints "run" or "skip"
#
# The stamp file's mtime is the last day every search test ran and passed. A full search run costs ~31 credits and a
# free Serper key holds 2,500, so run them every <every-days> (default 7) instead of daily: ~80 weeks of credit instead
# of ~80 days. <every-days> 0 (or no stamp yet, or a malformed value) = run. The 30 minutes of slack keep a 05:20 run
# from missing by the few minutes the previous run took.
search_gate() {
  local stamp="$1" every="${2:-7}"
  case "$every" in ''|*[!0-9]*) every=7 ;; esac
  if [ "$every" -le 0 ] || [ ! -f "$stamp" ]; then echo run; return 0; fi
  if [ -n "$(find "$stamp" -maxdepth 0 -mmin "+$((every * 1440 - 30))" 2>/dev/null)" ]; then echo run; else echo skip; fi
}
