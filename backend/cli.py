#!/usr/bin/env python3
"""
Scripted CLI driver — the Phase 1 acceptance harness.

Runs one query through the real orchestrator in-process with a printing
``emit``, so the whole retrieve -> stream answer -> async highlight flow is
exercisable before any frontend exists. Requires a crawled ``chroma_db`` and
``ANTHROPIC_API_KEY``.

    python -m backend.cli --query "how do I pay my water bill" [--session S] [--no-highlight]
    python -m backend.cli                                        # interactive REPL

Without --query, starts an interactive REPL so the embedding model loads once
and multiple queries can be run in sequence. Type ``exit`` or Ctrl-D to quit.

The answer streams token-by-token to STDOUT; verbose diagnostics (retrieval, the
links being fetched for highlighting, snapped spans, and a `[db]` summary) go to
STDERR. Pass ``--quiet`` to suppress diagnostics, or redirect ``... 2>/dev/null``.
"""

import argparse
import asyncio
import dataclasses
import json
import sys
import time

from .app import build_deps
from .config import Settings


def _print_event(event: dict):
    etype = event.get("type", "?")
    if etype == "answer_token":
        sys.stdout.write(event.get("text", ""))
        sys.stdout.flush()
    elif etype == "narration":
        print(f"[narration] {event.get('text','')}")
    elif etype == "answer_done":
        print("\n[answer_done]")
    elif etype == "supplement_start":
        print(f"\n[supplement] {event.get('text','')}")
    elif etype == "supplement_token":
        sys.stdout.write(event.get("text", ""))
        sys.stdout.flush()
    elif etype == "supplement_done":
        print("\n[supplement_done]")
    elif etype == "highlight":
        print(f"[highlight] {event.get('url')}\n      quote: {event.get('quote')!r}")
    elif etype == "not_found":
        print(f"\n[not_found] {event.get('text','')}")
        print(f"  redirect: {json.dumps(event.get('redirect_to_human'))}")
    elif etype == "session":
        print(f"[session] {event.get('session_id')}")
    else:
        print(f"[{etype}] {json.dumps({k: v for k, v in event.items() if k != 'type'})}")


def _dbg(msg: str):
    # Diagnostics on stderr so they interleave on a terminal but stay out of a
    # piped/captured event stream.
    print(f"  · {msg}", file=sys.stderr, flush=True)


def _summarize_db(store, interaction_id: str):
    """Quick post-run dump of what was logged for this interaction."""
    c = store.conn
    row = store.get_interaction(interaction_id)
    print("\n[db] interaction summary", file=sys.stderr)
    print(f"  outcome={row['outcome']}  tokens_in={row['tokens_in']}  "
          f"tokens_out={row['tokens_out']}  latency_ms={row['latency_ms']}", file=sys.stderr)
    calls = c.execute(
        "SELECT seq, call_type, model, tokens_in, tokens_out, latency_ms "
        "FROM model_calls WHERE interaction_id=? ORDER BY seq", (interaction_id,)).fetchall()
    print(f"  model_calls ({len(calls)}):", file=sys.stderr)
    for k in calls:
        print(f"    {k['seq']}. {k['call_type']:<9} {k['model']}  "
              f"in={k['tokens_in']} out={k['tokens_out']} {k['latency_ms']}ms", file=sys.stderr)
    rets = c.execute(
        "SELECT COUNT(*) FROM retrievals WHERE interaction_id=?", (interaction_id,)).fetchone()[0]
    vers = c.execute(
        "SELECT source_url, verified FROM verifications WHERE interaction_id=?",
        (interaction_id,)).fetchall()
    print(f"  retrievals: {rets}", file=sys.stderr)
    if vers:
        print(f"  highlights ({len(vers)}): "
              + ", ".join(f"{'OK' if v['verified'] else 'miss'} {v['source_url']}" for v in vers),
              file=sys.stderr)


async def _run_query(deps, query: str, session_id: str, quiet: bool):
    async def emit(event):
        _print_event(event)

    t0 = time.perf_counter()
    interaction_id = await deps.orchestrator.handle_turn(query, session_id, emit)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    print(f"\n[interaction_id] {interaction_id}")
    print(f"[total] {elapsed_ms} ms (wall clock, includes the async highlight pass)")
    if not quiet:
        _summarize_db(deps.store, interaction_id)


async def _run(query: str, session_id: str, quiet: bool, settings: Settings):
    deps = await asyncio.to_thread(build_deps, settings, None if quiet else _dbg)
    await _run_query(deps, query, session_id, quiet)
    deps.store.close()


async def _repl(session_id: str, quiet: bool, settings: Settings):
    print("Loading… (embedding model)", file=sys.stderr, flush=True)
    deps = await asyncio.to_thread(build_deps, settings, None if quiet else _dbg)
    print("Ready. Type a question, or 'exit' / Ctrl-D to quit.\n", file=sys.stderr, flush=True)
    try:
        while True:
            try:
                query = input("gigi> ").strip()
            except EOFError:
                print("", file=sys.stderr)
                break
            if not query:
                continue
            if query.lower() in ("exit", "quit"):
                break
            await _run_query(deps, query, session_id, quiet)
            print()
    finally:
        deps.store.close()


def main():
    parser = argparse.ArgumentParser(description="Gigi V3 backend CLI driver")
    parser.add_argument("--query", default=None, help="The user question to run (omit for REPL)")
    parser.add_argument("--session", default="cli-session", help="Session id (history reuse)")
    parser.add_argument("--top-k", type=int, default=None,
                        help="Retrieval depth (overrides TOP_K env / default); tune recall")
    parser.add_argument("--min-score", type=float, default=None,
                        help="Minimum cosine similarity in [0,1] (overrides MIN_SCORE env / default)")
    parser.add_argument("--no-highlight", action="store_true",
                        help="Skip the async highlight pass (stream the answer only)")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress the stderr diagnostics")
    args = parser.parse_args()

    settings = Settings.from_env()
    overrides = {}
    if args.top_k is not None:
        overrides["top_k"] = args.top_k
    if args.min_score is not None:
        overrides["min_score"] = args.min_score
    if args.no_highlight:
        overrides["highlight_enabled"] = False
    if overrides:
        settings = dataclasses.replace(settings, **overrides)
    if not args.quiet:
        _dbg(f"highlight: {'on' if settings.highlight_enabled else 'off'}  "
             f"top_k={settings.top_k}  min_score={settings.min_score}")

    if args.query:
        asyncio.run(_run(args.query, args.session, args.quiet, settings))
    else:
        asyncio.run(_repl(args.session, args.quiet, settings))


if __name__ == "__main__":
    main()
