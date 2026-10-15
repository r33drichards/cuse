# SPDX-License-Identifier: GPL-3.0-or-later
"""Dependency-free runtime command compiler. Help syntax is evidence, not a type system."""

import hashlib
import json
import re

SCHEMA_VERSION = 1
GENERATOR_VERSION = "2"
LINE = r"^[^\x00-\x1f\x7f]*$"
TOKEN = r"^[^\s\"'\\\x00-\x1f\x7f]+$"


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=True).encode()
    ).hexdigest()


def line(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(LINE, value)
        or len(value.encode()) > 16384
    ):
        raise ValueError("Expected a single line of at most 16384 UTF-8 bytes")
    return value


def compile_variant(syntax):
    """Only independent trailing optional tokens, literals, enums and placeholders.

    No shell quoting: WeeChat callback tokenizers differ. Single tokens forbid
    whitespace/quotes/backslashes; opaque syntax uses a verbatim raw fallback.
    All placeholders remain strings; help names alone never imply numeric types.
    """
    if not syntax.strip():
        return None  # Empty help is not proof that the callback takes no arguments.
    tokens = syntax.split()
    fields, serial, required = {}, [], []
    optional_seen = False
    for i, token in enumerate(tokens):
        optional = token.startswith("[") and token.endswith("]")
        token = token[1:-1] if optional else token
        if optional_seen and not optional:
            return None
        optional_seen |= optional
        placeholder = re.fullmatch(r"<([A-Za-z][A-Za-z0-9_]*)>", token)
        literals = token.split("|")
        if placeholder:
            key = placeholder[1]
            schema = {"type": "string", "pattern": TOKEN}
        elif all(re.fullmatch(r"-?[A-Za-z0-9_]+", x) for x in literals):
            key = "token_" + str(i + 1)
            schema = {"type": "string", "enum": literals}
        else:
            return None
        if key in fields:
            return None
        fields[key] = schema
        serial.append({"field": key, "optional": optional})
        if not optional:
            required.append(key)
    return {
        "type": "object",
        "properties": fields,
        "required": required,
        "additionalProperties": False,
    }, serial


def build_manifest(records, weechat_version="unknown", source=None):
    if source and source.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported command source manifest schema version")
    commands = []
    # Preserve registrations by plugin, not just by command name.
    for record in sorted(records, key=lambda x: (x["plugin"], x["name"])):
        identity = [record["plugin"], record["name"]]
        item = dict(record)
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", "_".join(identity))[:70]
        item["tool_name"] = "weechat_cmd_" + safe + "_" + digest(identity)[:12]
        variants, unsupported = [], []
        for index, syntax in enumerate(record["args"].split(" || ")):
            compiled = compile_variant(syntax)
            if compiled is None:
                unsupported.append(syntax)
            else:
                schema, serial = compiled
                variants.append(
                    {
                        "id": "v" + str(index),
                        "syntax": syntax,
                        "schema": schema,
                        "serialization": serial,
                    }
                )
        if source:
            candidates = [
                c
                for c in source.get("commands", [])
                if c.get("name") == record["name"]
                and c.get("plugin") == record["plugin"]
            ]
            item["source_evidence"] = {
                "registrations": candidates,
                "comparison": "Exact args string only; callback semantics and build conditions unverified",
                "status": "matched"
                if candidates
                and all(c.get("args") == record["args"] for c in candidates)
                else "drift_or_unresolved"
                if candidates
                else "runtime_only",
            }
        item["variants"] = variants
        item["unparsed_syntax"] = unsupported
        item["coverage"] = (
            "mixed" if variants and unsupported else "raw" if unsupported else "typed"
        )
        item["raw_fallback"] = True  # Also allows valid forms undocumented by help.
        item["revision"] = digest(
            {
                "record": record,
                "generator": GENERATOR_VERSION,
                "weechat": weechat_version,
            }
        )
        commands.append(item)
    return {
        "schema_version": SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "origin": {"kind": "runtime:hook(command)", "weechat_version": weechat_version},
        "source": {
            **source.get("source", {}),
            "schema_version": source.get("schema_version"),
            "extractor_version": source.get("extractor_version"),
            "limitations": source.get("limitations", []),
        }
        if source
        else None,
        "commands": commands,
        "coverage": {
            "total": len(commands),
            **{
                k: sum(c["coverage"] == k for c in commands)
                for k in ("typed", "mixed", "raw")
            },
        },
    }


def tool_spec(item):
    common = {
        "buffer": {
            "type": "string",
            "description": "Exact full buffer name; core.weechat is valid",
        },
        "registry_revision": {"type": "string", "const": item["revision"]},
    }
    required = ["buffer", "registry_revision", "syntax", "params"]

    def branch(syntax, params):
        # Hosts may flatten oneOf into function signatures without retaining
        # sibling properties. Every branch must be a complete callable schema.
        return {
            "type": "object",
            "properties": {
                **common,
                "syntax": {"type": "string", "const": syntax},
                "params": params,
            },
            "required": required,
            "additionalProperties": False,
        }

    branches = [branch(v["id"], v["schema"]) for v in item["variants"]]
    branches.append(
        branch(
            "raw",
            {
                "type": "object",
                "properties": {"arguments": {"type": "string", "pattern": LINE}},
                "required": ["arguments"],
                "additionalProperties": False,
            },
        )
    )
    return {
        "name": item["tool_name"],
        "description": (
            item["description"]
            + "\nWeeChat /"
            + item["name"]
            + " ("
            + item["plugin"]
            + "). Syntax: "
            + item["args"]
            + "\n"
            + item["args_description"]
            + "\nFull control. Raw fallback is verbatim WeeChat syntax, not shell escaping. "
            + "Command semantics can execute other commands or change configuration. "
            + "Variants: "
            + "; ".join(v["id"] + "=" + v["syntax"] for v in item["variants"])
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **common,
                "syntax": {"type": "string"},
                "params": {"type": "object"},
            },
            "required": required,
            "additionalProperties": False,
            "oneOf": branches,
        },
    }


def serialize(item, arguments):
    if not isinstance(arguments, dict) or set(arguments) != {
        "buffer",
        "registry_revision",
        "syntax",
        "params",
    }:
        raise ValueError("Expected buffer, registry_revision, syntax and params")
    if arguments["registry_revision"] != item["revision"]:
        raise ValueError("Command metadata changed; rediscover tools")
    params = arguments["params"]
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    if arguments["syntax"] == "raw":
        if set(params) != {"arguments"}:
            raise ValueError("Raw fallback requires only arguments")
        return line(params["arguments"])
    variant = next(
        (v for v in item["variants"] if v["id"] == arguments["syntax"]), None
    )
    if variant is None:
        raise ValueError("Unknown syntax variant")
    schema = variant["schema"]
    if set(params) - set(schema["properties"]) or set(schema["required"]) - set(params):
        raise ValueError("Unexpected or missing typed argument")
    values, gap = [], False
    for part in variant["serialization"]:
        key = part["field"]
        if key not in params:
            gap = True
            continue
        if gap:
            raise ValueError("Cannot skip an earlier positional argument")
        value = line(params[key])
        field = schema["properties"][key]
        if ("enum" in field and value not in field["enum"]) or (
            "pattern" in field and not re.fullmatch(field["pattern"], value)
        ):
            raise ValueError(
                "Invalid typed token; use raw syntax for callback-specific quoting"
            )
        values.append(value)
    return line(" ".join(values))
