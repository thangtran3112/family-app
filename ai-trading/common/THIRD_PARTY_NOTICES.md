# Third-Party Notices

`ai-trading/common` adapts the code below. Each adapted file says so in its header.

## Vibe-Trading

Source: https://github.com/HKUDS/Vibe-Trading (pinned as `ai-trading/packages/vibe-trading`), commit `d402c2df9bc6162f314df5bc5d06ba30ebc3332d`.

| Common file | Adapted from | Changes |
|---|---|---|
| `src/ai_trading_common/http.py` (`HostThrottle`, `ThrottledClient`) | `agent/backtest/loaders/_http.py` (`HostThrottle`, `throttled_get_json`) | Dropped the environment-variable lookups and `positive_env_float`; callers pass `min_interval` and `user_agent` explicitly instead of a shared default; added bounded retries with backoff for timeouts, connection errors, and 5xx; added a soft-ban latch per host key (429, or a 403 on a caller-declared ban-prone host, raises `SoftBanned` and blocks further requests until `Retry-After` or a default cooldown); the clock and sleep are injectable so tests use a fake clock instead of a real sleep |

```text
MIT License

Copyright (c) 2026 Vibe-Trading Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## TradingAgents

Source: https://github.com/TauricResearch/TradingAgents (pinned as `ai-trading/packages/trading-agents`), commit `1394a3f72aa4393e1a98f51b382434c4b4c2d972`.

Attribution: TradingAgents (TauricResearch/TradingAgents). Apache License 2.0. The repository has no separate NOTICE file. The adapted file is marked as modified in its own header, per section 4(b) of the license.

| Common file | Adapted from | Changes |
|---|---|---|
| `src/ai_trading_common/bars.py` (`drop_unclosed`) | `tradingagents/dataflows/vendors/yahoo/ohlcv.py`, `market.py` | No code copied (a different frame shape: the Desk's shared `open/high/low/close/volume` bars, not yfinance's daily `Date`-indexed rows); kept the idea of inclusive ends (each client's own request range, not this module); "partial-bar refresh" became `drop_unclosed`'s close-time guard (never keep a bar whose period has not closed), generalized to 1d/1h/1m bar edges and the XNYS half-day close that ohlcv.py's daily-only rule does not need |
| `src/ai_trading_common/providers/sec_edgar.py` | `tradingagents/dataflows/vendors/sec_edgar.py` | Kept the CIK-lookup shape, the span classification idea (`_span_index`/`_SPANS`/`_YEAR_TO_DATE`, renamed `_classify_span`/`_SPAN_RANGES`), and the amendment rule ("a period reported more than once takes its latest filing on or before the date"). Changed: returns typed `Fact` rows (now in `ai_trading_common.types`, 02j) instead of a rendered statement string or a flattened label map, so a caller picks its own concepts; the point-in-time cut is a separate pure `facts_as_of(facts, as_of)` function (also in `types.py`) instead of being inlined in the fetch; errors map to this package's `ProviderError` hierarchy instead of `NoMarketDataError`/`VendorUnavailableError`; no on-disk cache (the shared `ThrottledClient` has none either); the 8-K Item 2.02 reader (`item_202_filings`, `_parse_item_202`, `eight_k_as_of`) is new, not present upstream |
| `src/ai_trading_common/providers/fred.py` | `tradingagents/dataflows/vendors/fred.py` | Kept the ALFRED vintage-pinning idea: both `realtime_start` and `realtime_end` set to the as-of date so a past run sees the value as first published. Changed: returns typed `Observation` rows (now in `ai_trading_common.types`, 02j) instead of a rendered markdown report; dropped the friendly-alias table, the look-back-day window, and the `pytz`/America-Chicago "FRED's own today" clamp (this client's `as_of` always names a historical date the caller chose, never "now"); errors map to this package's `ProviderError` hierarchy instead of raising bare `ValueError`/a vendor-specific `NotConfiguredError`; adds `release_dates` (new, not present upstream) |

The complete, verbatim upstream LICENSE (`ai-trading/packages/trading-agents/LICENSE`):

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## `ai-trading/packages/market-data/` (ours; open-source lane)

Not a third party: `alpaca.py` moved here from `ai-trading/market-data/` per
the Phase 2 reuse map (02a §11, "move") and into `packages/` per the 2026-11-01
layout cleanup. Same author, no license notice needed.
See `src/ai_trading_common/providers/alpaca.py`'s module docstring for what changed.

`sec_edgar.py` also compares its design with `ai-trading/packages/market-data/sec.py`
(ours; left untouched) and keeps that file's ticker-to-CIK lookup (including
the `BRK.B` -> `BRK-B` mapping) and its "404 means nothing here" handling,
alongside TradingAgents' span classification and amendment rule above. Same
author, no license notice needed; see
`src/ai_trading_common/providers/sec_edgar.py`'s module docstring.

## No notice needed: `providers/finnhub.py`, `providers/alphavantage.py`, `providers/eulerpool.py`

No upstream code is adapted. `finnhub.py`'s `news_as_of` (now in
`ai_trading_common.types`, 02j) reuses the *idea* of TradingAgents' news
handling -- "unavailable" (the client call itself failing) kept apart from
"no news" (an empty, successfully-fetched list) -- with no code copied, so
per the brief ("A 'pattern' reuse ... needs no notice") this carries no
entry.

`providers/finnhub.py`, `providers/alphavantage.py`, and
`providers/eulerpool.py` are all written fresh against each provider's own
public API documentation (Finnhub's and Alpha Vantage's official docs;
Eulerpool's `https://eulerpool.com/llms-full.txt` endpoint reference, since
the marketing/docs site itself returns HTTP 403 to a non-browser `GET`).
`registry.py`, `types.py`, and `sources.py` (02j) are this package's own
design, written fresh against no upstream reference.
