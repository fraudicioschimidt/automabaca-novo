#!/usr/bin/env python3
"""Acknowledge an investigated journal gap without resetting the collection cursor."""
import argparse
import fcntl
import os
import archive_common as common

REASONS = ('reviewed-with-metrics', 'recovered-from-backup', 'accepted-missing-interval')


def acknowledge(state, expected, reason):
    if not expected or state.get('gapDetectedAt') != expected or reason not in REASONS:
        raise ValueError('gap_acknowledgment_mismatch')
    updated = dict(state)
    updated.pop('gapDetectedAt')
    updated['lastGapAcknowledgment'] = {'gapDetectedAt': expected, 'acknowledgedAt': common.stamp(), 'reason': reason}
    return updated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-detected-at', required=True)
    parser.add_argument('--reason', required=True, choices=REASONS)
    args = parser.parse_args()
    os.umask(0o077)
    with (common.STATE / 'collect.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = acknowledge(common.read_json(common.STATE / 'cursor.json', {}), args.expected_detected_at, args.reason)
        common.atomic_json(common.STATE / 'cursor.json', state)
        common.event('LOG_ARCHIVE_GAP_ACKNOWLEDGED', **state['lastGapAcknowledgment'])


if __name__ == '__main__': main()
