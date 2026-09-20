# Superseded or incomplete runs under protocol 0.2.0

- `gpt-5.4-mini-overall-incomplete`: the arm crashed after its calls
  because OpenAI response bodies carry no gateway routing metadata and
  one generation lookup failed, leaving the model report without a
  provider; record validation refused it loudly (no records were
  written). The fix - fall back to the model id's creator prefix and
  drop unconfirmable model identities - landed before the arm was rerun.
