#!/bin/bash

# This script executes a specified script on a remote host via SSH, logs the output
# to a temporary file, and optionally formats the log output periodically using a
# specified formatter script.

trap "exit" INT TERM
trap "kill 0" EXIT

no_echo() {
    : # nothing
}

spin () {
    pid=$1
    local -a chars=( '⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷'
'⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯'
'⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟'
'⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿'
'⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿'
'⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻ ⣟ ⡿ ⣷ ⣯ ⣽ ⣾ ⢿ ⣻'
'⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽ ⣯ ⢿ ⣾ ⣟ ⣻ ⣷ ⡿ ⣽'
'⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾ ⣷ ⣻ ⣽ ⡿ ⢿ ⣯ ⣟ ⣾' )
    local i=0
    while kill -0 $pid 2>/dev/null; do
        printf '  %s\r' "${chars[i++ % ${#chars[@]}]}"
        sleep 0.2
    done
}

if [ ! -z "$NO_ECHO" ]; then
    printout="no_echo"
else
    printout="echo"
fi

log_file="/tmp/.$$.log"
lock_log_file="/tmp/$$.log.lock"

# Check if the target host is specified
target_host="aen${1}cembalo"
ssh_destination="scor@${target_host}"
shift

# Check if the script to execute is specified and exists
script_path=${1}
if [ ! -f "${script_path}" ]; then
    script_path=`which ${1}`
    if [ ! -f "${script_path}" ]; then
        ${printout} "Error: script '${1}' not found."
        exit 1
    fi
fi
shift

# Parse the remaining arguments for the script to execute and any optional formatter script
script_args=()
double_dash_found=false
for var in "$@"; do
    if [[ "$var" == "--" ]]; then
        shift
        double_dash_found=true
        break
    fi
    script_args+=("$var")
done

# Check if a formatter script is specified and set the output log file
if [ "$double_dash_found" = true ]; then
    formatter_call=${1}
    shift
    output_log_file=$1
    if [ -z "${output_log_file}" ]; then
        ${printout} "Warning: output log file not specified: outputting to stdout."
    else
        [ -n "${output_log_file}" ] && truncate -s 0 "${output_log_file}"
    fi
    
    output_log_file=${1}
    if [ -z "${output_log_file}" ]; then
        ${printout} "Warning: output log file not specified: outputting to stdout."
    else
        [ -n "${output_log_file}" ] && truncate -s 0 "${output_log_file}"
    fi
fi

# Start the formatter loop if a formatter script is specified
if [ ! -z "${formatter_call}" ]; then
    log_formatter=`which ${formatter_call}`
    if [ ! -f "${log_formatter}" ]; then
        ${printout} "Error: script '${formatter_call}' not found or not executable."
        exit 1
    fi
    # start periodic formatter loop in background
    (
        while true; do
            sleep "${formatter_interval:-5}"
            flock "${lock_log_file}" -c "${log_formatter} ${log_file} ${output_log_file} && truncate -s 0 '${log_file}'"
        done
    ) &
    trap "flock '${lock_log_file}' -c \"${log_formatter} ${log_file} ${output_log_file} && truncate -s 0 '${log_file}'\"; kill 0" EXIT
fi

# Execute the script on the remote host and log output to a temporary file
${printout} -e "Executing script '${script_path}' on remote host '${ssh_destination}' with arguments: [${script_args[*]}]"
if [ -n "${output_log_file}" ]; then
    ${printout} ">> Logging output to '${output_log_file}'"
else
    ${printout} ">> Logging output to stdout"
fi

# Create a temporary shim script that sets the positional parameters for the remote script
shimed_script_call="/tmp/$$.$(basename "${script_path}").call"
insert_line="set -- \"\${@}\" '${script_args[*]}'"
if [[ "$(head -1 "${script_path}")" == "#!"* ]]; then
    { head -1 "${script_path}"; printf '%s\n' "${insert_line}"; tail -n +2 "${script_path}"; } > "${shimed_script_call}"
else
    { printf '%s\n' "${insert_line}"; cat "${script_path}"; } > "${shimed_script_call}"
fi

# If a formatter script is specified, the output will be formatted periodically 
# and written to the specified output log file.
# Otherwise, the output will be written directly to stdout.
if [ -n "${formatter_call}" ]; then
    ssh ${ssh_destination} "bash -s" < <(cat "${shimed_script_call}") >> "$log_file" &
else
    ssh ${ssh_destination} "bash -s" < <(cat "${shimed_script_call}") &
fi

ssh_pid=$!
# no spinner if output_log_file is not specified
if [ -n "${output_log_file}" ] && [[ -z $NO_ECHO || $NO_ECHO -lt 2 ]]; then
    echo -e "\nEnter Ctrl+Z to interrupt the remote script.\n"

    # Wait for the SSH command to finish and show a spinner while waiting
    spin $ssh_pid
    printf '\r\033[K'  # clear spinner line
fi
wait $ssh_pid