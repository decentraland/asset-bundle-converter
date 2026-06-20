using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DCL.ABConverter
{
    /// <summary>
    /// Pure (file-IO-free) text transforms used to make serialized Unity asset YAML
    /// deterministic across conversions. Extracted from AssetBundleConverter so the
    /// transforms can be tested in isolation; the logic is byte-for-byte identical to
    /// the original inline implementations.
    /// </summary>
    public static class DeterministicYaml
    {
        public static string RemapSubAssetIds(string yaml, string seed)
        {
            string txt = yaml;

            // Unity writes the YAML docs in ascending original-localID order, and
            // those localIDs are a per-session random draw — so a positional index
            // is NOT deterministic across conversions. Sort the docs by content
            // (classID, m_Name, body) and index in that order instead. Only the
            // embedded AnimationClip docs surface as bundle objects, and class 74
            // sorts before the state/transition classes, so clips always take the
            // first indices in name order. Docs with identical keys are mutually
            // interchangeable (identical bodies), so any stable order is byte-equal.
            var docs = new List<(int classId, long oldId, string name, string body)>();
            var headers = Regex.Matches(txt, @"^--- !u!(\d+) &(-?\d+)", RegexOptions.Multiline);

            for (int i = 0; i < headers.Count; i++)
            {
                Match m = headers[i];
                long oldId = long.Parse(m.Groups[2].Value);
                // Skip Unity built-in / global object IDs: those are small, stable
                // localIDs (script refs, importers, ...) that are already deterministic.
                // Only the large, per-session-random sub-asset localIDs (>=10M) get remapped.
                if (Math.Abs(oldId) < 10_000_000) continue;
                int bodyStart = m.Index + m.Length;
                int bodyEnd = i + 1 < headers.Count ? headers[i + 1].Index : txt.Length;
                string body = txt.Substring(bodyStart, bodyEnd - bodyStart);
                string name = Regex.Match(body, @"^  m_Name: (.*)$", RegexOptions.Multiline).Groups[1].Value;
                docs.Add((int.Parse(m.Groups[1].Value), oldId, name, body));
            }

            docs.Sort((a, b) =>
            {
                int c = a.classId.CompareTo(b.classId);
                if (c != 0) return c;
                c = string.CompareOrdinal(a.name, b.name);
                return c != 0 ? c : string.CompareOrdinal(a.body, b.body);
            });

            var ids = new Dictionary<long, long>();
            int idx = 0;

            foreach (var doc in docs)
            {
                if (ids.ContainsKey(doc.oldId)) continue;
                byte[] h = Utils.md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes($"{seed}/{idx++}"));
                ids[doc.oldId] = BitConverter.ToInt64(h, 0);
            }

            // Single-pass replacement keyed on the captured id: rewrite each
            // matched id by dictionary lookup. Doing it per-id with sequential
            // Regex.Replace calls on the mutating text risks cascading
            // corruption (a freshly assigned id colliding with an original id
            // not yet rewritten); one pass is also O(fileSize), not O(ids*fileSize).
            txt = Regex.Replace(txt, @"&(-?\d+)\b",
                m => ids.TryGetValue(long.Parse(m.Groups[1].Value), out long id) ? $"&{id}" : m.Value);
            txt = Regex.Replace(txt, @"fileID: (-?\d+)\b",
                m => ids.TryGetValue(long.Parse(m.Groups[1].Value), out long id) ? $"fileID: {id}" : m.Value);
            return txt;
        }

        /// <summary>
        /// Canonicalizes the iteration order of the AnimatorController's m_TOS map
        /// (the transform-of-string table: CRC32 hash -> string path/state name).
        ///
        /// Unity's native mecanim builder fills m_TOS in the iteration order of an
        /// engine-internal hash container, so the serialized order is a per-build
        /// permutation that is *not* a function of the recorded CRC keys and is not
        /// reproducible offline. m_TOS is a pure lookup table — consumers always
        /// index it by hash and never rely on iteration order — so rewriting the
        /// order is byte-neutral semantically. We re-emit the entries sorted ascending
        /// by their CRC32 key, which is the canonical order the downstream converter
        /// expects, so the built bundle's m_TOS matches that reference by construction.
        ///
        /// Same mechanism/phase as RemapSubAssetIds: a structured rewrite
        /// of the already-serialized .controller text, run after SaveAssets/Refresh
        /// and before BuildAssetBundles. Scope is naturally limited to AnimatorController
        /// docs (only they carry m_TOS).
        ///
        /// In editor YAML, m_TOS serializes either as a mapping
        ///     m_TOS:
        ///       0:&lt;path&gt;
        ///       23966416: Loop
        /// or (depending on type-tree flags) as a sequence of first/second pairs
        ///     m_TOS:
        ///     - first: 0
        ///       second: &lt;path&gt;
        /// Both forms are handled.
        ///
        /// Returns the input string instance unchanged (same reference) when no
        /// reorder was needed, so callers can skip the file write via ReferenceEquals.
        /// </summary>
        public static string ReorderTosOrder(string yaml)
        {
            string txt = yaml;

            // Split into physical lines, preserving each line's own terminator so the
            // rewrite is byte-faithful (CRLF/LF mixes survive untouched).
            var lines = SplitKeepEol(txt);

            bool changed = false;
            int i = 0;
            while (i < lines.Count)
            {
                // Find a "  m_TOS:" header line (a key whose value is on following lines).
                var hdr = Regex.Match(StripEol(lines[i]), @"^(?<indent>[ \t]*)m_TOS:[ \t]*$");
                if (!hdr.Success) { i++; continue; }

                string indent = hdr.Groups["indent"].Value;
                int bodyStart = i + 1;
                int bodyEnd = bodyStart;

                // The block body is every following line that is part of the m_TOS
                // value: a deeper-indented line (mapping entries / "second:" continuation)
                // OR a sequence item ("- ...") at the header indent. Stops at the first
                // sibling key (same indent, not a sequence item) or shallower line.
                while (bodyEnd < lines.Count)
                {
                    string raw = StripEol(lines[bodyEnd]);
                    if (raw.Length == 0) break; // blank line ends the block defensively
                    string lead = Regex.Match(raw, @"^[ \t]*").Value;
                    bool isSeqItem = Regex.IsMatch(raw, @"^[ \t]*-");
                    bool deeper = lead.Length > indent.Length;
                    bool seqAtIndent = isSeqItem && lead.Length == indent.Length;
                    if (deeper || seqAtIndent) { bodyEnd++; continue; }
                    break;
                }

                if (bodyEnd == bodyStart) { i = bodyEnd; continue; } // empty m_TOS block

                // Group the body lines into entries. Each entry starts at either a
                // sequence item ("- first: <crc>") or a mapping line ("<crc>: <value>"),
                // and includes any following continuation lines (e.g. "  second: ...").
                var entries = new List<(uint crc, List<string> lns)>();
                bool parseable = true;
                int j = bodyStart;
                while (j < bodyEnd)
                {
                    string raw = StripEol(lines[j]);
                    // sequence form: "- first: <crc>"
                    var seq = Regex.Match(raw, @"^[ \t]*-[ \t]*first:[ \t]*(\d+)[ \t]*$");
                    // mapping form: "<crc>: <value>"
                    var map = Regex.Match(raw, @"^[ \t]*(\d+):");
                    uint crc;
                    if (seq.Success) crc = uint.Parse(seq.Groups[1].Value);
                    else if (map.Success) crc = uint.Parse(map.Groups[1].Value);
                    else { parseable = false; break; }

                    var group = new List<string> { lines[j] };
                    int k = j + 1;
                    // absorb continuation lines (no new entry header) until the next
                    // entry header or the end of the block.
                    while (k < bodyEnd)
                    {
                        string r2 = StripEol(lines[k]);
                        bool nextIsSeq = Regex.IsMatch(r2, @"^[ \t]*-[ \t]*first:");
                        bool nextIsMap = Regex.IsMatch(r2, @"^[ \t]*\d+:");
                        if (nextIsSeq || nextIsMap) break;
                        group.Add(lines[k]);
                        k++;
                    }
                    entries.Add((crc, group));
                    j = k;
                }

                if (!parseable || entries.Count == 0) { i = bodyEnd; continue; }

                // Stable-sort ascending by CRC32 key (OrderBy is stable).
                var sorted = entries.OrderBy(e => e.crc).ToList();

                // Only rewrite if the order actually changed.
                bool reordered = false;
                for (int t = 0; t < entries.Count; t++)
                    if (entries[t].crc != sorted[t].crc) { reordered = true; break; }

                if (reordered)
                {
                    var rebuilt = new List<string>();
                    foreach (var e in sorted) rebuilt.AddRange(e.lns);
                    lines.RemoveRange(bodyStart, bodyEnd - bodyStart);
                    lines.InsertRange(bodyStart, rebuilt);
                    changed = true;
                }

                i = bodyStart + entries.SelectMany(e => e.lns).Count();
            }

            if (changed)
                return string.Concat(lines);

            return yaml;
        }

        // Splits text into lines, each retaining its trailing EOL ("\r\n", "\n", or
        // none for a final unterminated line). Concatenating the result reproduces the
        // input exactly.
        private static List<string> SplitKeepEol(string txt)
        {
            var result = new List<string>();
            int start = 0;
            for (int i = 0; i < txt.Length; i++)
            {
                if (txt[i] == '\n')
                {
                    result.Add(txt.Substring(start, i - start + 1));
                    start = i + 1;
                }
            }
            if (start < txt.Length) result.Add(txt.Substring(start));
            return result;
        }

        private static string StripEol(string line) => line.TrimEnd('\r', '\n');
    }
}
