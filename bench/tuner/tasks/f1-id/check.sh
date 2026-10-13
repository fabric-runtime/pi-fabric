#!/bin/sh
# exit 0 = pass. On a failure, the partial score comes from the depot call log.
got=$(cat answer.txt 2>/dev/null | tr -d '[:space:]')
if [ "$got" = "P-1001" ]; then echo "score: 1"; exit 0; fi
n=$(curl -s "${QUIRK_URL:-http://127.0.0.1:4747}/admin/cell/$TUNER_CELL" | grep -o '"ok":[0-9][0-9]*' | head -1 | cut -d: -f2)
echo "answer.txt is wrong or missing (got '${got:-<missing>}'). Successful depot calls: ${n:-0}. The task needs 1."
echo "score: $(awk "BEGIN{n=${n:-0}; if (n > 1) n = 1; print 0.8*n/1}")"
exit 1
