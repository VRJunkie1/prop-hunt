#!/usr/bin/env bash
# One-off: fetch all Restaurant Bits GLBs from poly.pizza into assets/restaurant/
set -u
cd "$(dirname "$0")" || exit 1
OUT="assets/restaurant"
TMP="_meshwork"
mkdir -p "$OUT" "$TMP"
MAN="$OUT/manifest.json"
LOG="$TMP/fetch.log"
: > "$LOG"

ids=$(grep -oiE '/m/[A-Za-z0-9_-]+' bundle.html | sed 's#/m/##' | sort -u)
total=$(echo "$ids" | wc -l | tr -d ' ')
echo "starting: $total model ids" | tee -a "$LOG"

ok=0; fail=0
echo "[" > "$MAN"
first=1
for id in $ids; do
  page="$TMP/$id.html"
  curl -sSL --retry 2 --max-time 30 -o "$page" "https://poly.pizza/m/$id"
  uuid=$(grep -oiE 'static\.poly\.pizza/[a-f0-9-]+\.glb' "$page" | head -1 | grep -oiE '[a-f0-9-]{36}')
  raw=$(grep -oiE '<title[^>]*>[^<]*' "$page" | head -1 | sed -E 's/<title[^>]*>//; s/ - Free.*//; s/ - Poly.*//')
  if [ -z "$uuid" ]; then
    echo "FAIL(no-uuid) $id" | tee -a "$LOG"; fail=$((fail+1)); continue
  fi
  base=$(echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')
  [ -z "$base" ] && base="model_$id"
  fname="$base.glb"
  if [ -e "$OUT/$fname" ]; then fname="${base}_${id}.glb"; fi
  curl -sSL --retry 2 --max-time 60 -o "$OUT/$fname" "https://static.poly.pizza/$uuid.glb"
  magic=$(head -c 4 "$OUT/$fname" 2>/dev/null)
  sz=$(wc -c < "$OUT/$fname" 2>/dev/null | tr -d ' ')
  if [ "$magic" = "glTF" ] && [ "${sz:-0}" -gt 100 ]; then
    ok=$((ok+1))
    [ $first -eq 0 ] && echo "," >> "$MAN"; first=0
    printf '  {"name":"%s","file":"assets/restaurant/%s","id":"%s","bytes":%s}' "$raw" "$fname" "$id" "$sz" >> "$MAN"
    echo "OK   $fname ($sz b)" | tee -a "$LOG"
  else
    rm -f "$OUT/$fname"
    echo "FAIL(bad-glb) $id -> $fname magic=$magic sz=${sz:-0}" | tee -a "$LOG"; fail=$((fail+1))
  fi
done
echo "" >> "$MAN"; echo "]" >> "$MAN"
echo "DONE ok=$ok fail=$fail / $total" | tee -a "$LOG"
