#!/bin/bash

while true; do
    ts=$(date '+%Y-%m-%dT%H:%M:%S')
    sudo docker stats --no-stream --format "json" \
      | jq -c --arg ts "$ts" '. + {timestamp: $ts}'

    sleep 5
done