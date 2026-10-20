"""Publish the Stop result atomically, with the transcript pointer ready first."""

import json
import os
import sys
import tempfile


def atomic_write(path, content):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", errors="replace", dir=os.path.dirname(path) or ".",
            prefix=os.path.basename(path) + ".", suffix=".tmp", delete=False,
        ) as output:
            temporary = output.name
            output.write(content)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def transcript_summary(path):
    summary = ""
    try:
        # Older Claude versions omit last_assistant_message. Read a bounded tail
        # rather than scanning a potentially huge resumed history under the hook
        # timeout. If the final record itself exceeds this bound, publish an empty
        # summary and let the driver fall back to the pane instead of hanging.
        with open(path, "rb") as transcript:
            size = transcript.seek(0, os.SEEK_END)
            offset = max(0, size - 4 * 1024 * 1024)
            transcript.seek(offset)
            if offset:
                transcript.readline()  # Discard the possibly partial first record.
            for line in transcript:
                try:
                    entry = json.loads(line)
                except (ValueError, TypeError, UnicodeError):
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "assistant":
                    continue
                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    text = "\n".join(
                        block["text"] for block in content
                        if isinstance(block, dict) and block.get("type") == "text"
                        and isinstance(block.get("text"), str)
                    )
                else:
                    continue
                if text.strip():
                    summary = text
    except (OSError, UnicodeError):
        pass
    return summary


def main():
    sentinel = os.environ.get("PI_CLAUDE_SENTINEL")
    if not sentinel:
        return
    try:
        payload = json.load(sys.stdin)
    except (ValueError, UnicodeError):
        return
    if not isinstance(payload, dict) or payload.get("stop_hook_active") is True:
        return

    transcript = payload.get("transcript_path")
    if isinstance(transcript, str) and transcript:
        try:
            atomic_write(sentinel + ".transcript", transcript + "\n")
        except (OSError, UnicodeError) as error:
            # Saving resumable history is optional; never lose completion for it.
            print(f"Could not save Claude transcript pointer: {error}", file=sys.stderr)
    else:
        transcript = ""

    # Unset preserves compatibility with scripts launched before this flag existed.
    if os.environ.get("PI_CLAUDE_AUTO_EXIT", "1") != "1":
        return

    summary = payload.get("last_assistant_message")
    if not isinstance(summary, str) or not summary.strip():
        summary = transcript_summary(transcript) if transcript else ""
    # Even an empty result is completion evidence: the driver can use pane output.
    # Rename last so the watcher never observes an empty/partially written result.
    atomic_write(sentinel, summary)


if __name__ == "__main__":
    main()
