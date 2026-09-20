# Superseded or incomplete runs under protocol 0.2.0

- `gpt-5.4-mini-overall-incomplete`: the arm crashed after its calls
  because OpenAI response bodies carry no gateway routing metadata and
  one generation lookup failed, leaving the model report without a
  provider; record validation refused it loudly (no records were
  written). The fix - fall back to the model id's creator prefix and
  drop unconfirmable model identities - landed before the arm was rerun.

The nine `*-verdict-only` runs here were recorded under protocol 0.2.0
before its 100-token verdict-only output limit was shown to truncate
gemini-3.8-flash timing responses with empty content (finish_reason
length; hidden reasoning tokens precede any visible output). Protocol
0.3.0 raises that limit to 1000 and the timing arms were rerun under
it; scored arms stay under 0.2.0, which 0.3.0 declares compatible for
them because the only diff is a parameter scored arms never use.
