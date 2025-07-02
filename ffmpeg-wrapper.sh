#!/bin/bash
# finds the -filter_complex argument and removes the trailing semicolon from its value before executing the real ffmpeg.

# The real ffmpeg binary is expected to be in /usr/bin/
REAL_FFMPEG="/usr/bin/ffmpeg"

# Copy all arguments into a new array
ARGS=("$@")
MODIFIED_ARGS=()
LENGTH=${#ARGS[@]}

# Loop through the arguments to find and fix -filter_complex
i=0
while [ $i -lt $LENGTH ]; do
  ARG="${ARGS[$i]}"

  if [ "$ARG" = "-filter_complex" ]; then
    # Add the -filter_complex flag itself
    MODIFIED_ARGS+=("$ARG")
    i=$((i + 1))

    # Get the next argument, which is the filter string
    FILTER_STRING="${ARGS[$i]}"

    # Remove the trailing semicolon using sed
    # This is a safe and portable way to do it.
    FIXED_STRING=$(echo "$FILTER_STRING" | sed 's/;$//')

    # Add the fixed filter string
    MODIFIED_ARGS+=("$FIXED_STRING")
  else
    # This is not the argument we're looking for, add it as is
    MODIFIED_ARGS+=("$ARG")
  fi

  i=$((i + 1))
done

exec "$REAL_FFMPEG" "${MODIFIED_ARGS[@]}"
