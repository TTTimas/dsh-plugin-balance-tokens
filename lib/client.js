window.__ModuleLoader__.load({
	id: "dsh-plugin-balance-tokens",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		const NS = "balance-tokens";
		const REFRESH_MS = 60000;

		/**
		 * Balance warning bands per currency, in that currency's units. A
		 * combined topped-up plus granted balance at or above `low` is
		 * sufficient, at or above `critical` is low, and below `critical` is a
		 * warning. Other currencies fall back to the CNY amounts.
		 */
		const BALANCE_BANDS = Object.freeze({
			CNY: Object.freeze({ low: 20, critical: 5 }),
			USD: Object.freeze({ low: 3, critical: 1 }),
		});
		const DEFAULT_BALANCE_BAND = BALANCE_BANDS.CNY;

		/**
		 * Session token-spend bands. Usage is green below `warn`, yellow from
		 * `warn` up to `danger`, and red at or above `danger`.
		 */
		const TOKEN_BANDS = Object.freeze({ warn: 1_000_000, danger: 5_000_000 });

		/**
		 * Remaining-context bands as a fraction of the context window: green at
		 * or above `warn`, yellow down to `danger`, red below.
		 */
		const CONTEXT_BANDS = Object.freeze({ warn: 0.3, danger: 0.1 });

		/** Severity → theme token for the status dot. */
		const SEVERITY_COLOR = Object.freeze({
			ok: "var(--dsw-alias-state-success-primary)",
			low: "var(--dsw-alias-state-warn-primary)",
			critical: "var(--dsw-alias-state-error-primary)",
		});

		/**
		 * Severity → amount text color. State tokens are tuned for fills; mixing
		 * each with the primary label keeps the 12px amount legible in both
		 * palettes (darker on light, lighter on dark).
		 */
		const SEVERITY_TEXT_COLOR = Object.freeze({
			ok: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary))",
			low: "color-mix(in srgb, var(--dsw-alias-state-warn-label) 70%, var(--dsw-alias-label-primary))",
			critical: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 80%, var(--dsw-alias-label-primary))",
		});

		/** Severity → locale key naming the balance band. */
		const SEVERITY_COPY = Object.freeze({
			ok: "balanceOk",
			low: "balanceLow",
			critical: "balanceCritical",
		});

		/** Severity → locale key naming the token-spend band. */
		const TOKEN_COPY = Object.freeze({
			ok: "tokenOk",
			low: "tokenHigh",
			critical: "tokenCritical",
		});

		/** Severity → locale key naming the remaining-context band. */
		const CONTEXT_COPY = Object.freeze({
			ok: "contextOk",
			low: "contextLow",
			critical: "contextCritical",
		});

		const zh = {
			balance: "余额",
			toppedUp: "充值",
			granted: "赠送",
			loading: "加载中…",
			notSignedIn: "账户未登录",
			balanceFailed: "余额获取失败",
			clickToRetry: "点击刷新余额",
			balanceOk: "余额充足",
			balanceLow: "余额偏低",
			balanceCritical: "余额预警，建议及时充值",
			balanceBandHint: "充足 ≥ {low}，偏低 < {low}，预警 < {critical}",
			tokenOk: "用量正常",
			tokenHigh: "用量偏高",
			tokenCritical: "用量预警",
			tokenBandHint: "低于 {warn} 正常，低于 {danger} 偏高，{danger} 及以上预警",
			contextOk: "上下文充足",
			contextLow: "上下文偏低",
			contextCritical: "上下文预警",
			contextBandHint: "剩余 ≥ {warn} 充足，< {warn} 偏低，< {danger} 预警",
			metricAria: "{status}（{value}）",
			noSession: "无活动会话",
			waitingUsage: "等待用量数据",
			usage: "本会话",
			contextLeft: "上下文剩余",
			tokens: "tokens",
		};

		const en = {
			balance: "Balance",
			toppedUp: "topped up",
			granted: "granted",
			loading: "loading…",
			notSignedIn: "signed out",
			balanceFailed: "balance unavailable",
			clickToRetry: "Refresh balance",
			balanceOk: "balance sufficient",
			balanceLow: "balance low",
			balanceCritical: "balance critical, top up soon",
			balanceBandHint: "sufficient at {low}+, low below {low}, critical below {critical}",
			tokenOk: "usage normal",
			tokenHigh: "usage high",
			tokenCritical: "usage warning",
			tokenBandHint: "normal below {warn}, high below {danger}, warning at {danger}+",
			contextOk: "context healthy",
			contextLow: "context low",
			contextCritical: "context warning",
			contextBandHint: "healthy at {warn}+ left, low below {warn}, warning below {danger}",
			metricAria: "{status} ({value})",
			noSession: "no active session",
			waitingUsage: "waiting for usage",
			usage: "session",
			contextLeft: "context left",
			tokens: "tokens",
		};

		/**
		 * Host release version carried by the boot graph; the account call's
		 * client metadata reports it as the requesting UI identity.
		 * @returns version string, or 0.0.0 when the graph is unavailable.
		 */
		function releaseVersion() {
			try {
				const graph = window.__DSH_BOOT__;
				const version = graph && graph.release && graph.release.version;
				return typeof version === "string" && version !== "" ? version : "0.0.0";
			} catch (_missingGraph) {
				return "0.0.0";
			}
		}

		/**
		 * Compact token count: 999, 12.3k, 1.20M.
		 * @param value - token count.
		 * @returns display text, or an em dash for a non-number.
		 */
		function formatTokens(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
			const n = Math.round(value);
			if (n < 1000) return String(n);
			if (n < 1000000) {
				const k = n / 1000;
				return (k >= 100 ? String(Math.round(k)) : k.toFixed(1)) + "k";
			}
			return (n / 1000000).toFixed(2) + "M";
		}

		/**
		 * Currency symbol for one Platform wallet.
		 * @param currency - wallet currency code.
		 * @returns symbol, or the code plus a space when unknown.
		 */
		function currencySymbol(currency) {
			if (currency === "CNY") return "¥";
			if (currency === "USD") return "$";
			return String(currency) + " ";
		}

		/**
		 * Parse one Platform wallet amount. Platform reports balances as decimal
		 * strings and pads empty wallets with values such as "0E-16".
		 * @param wallet - { currency, balance } wallet row.
		 * @returns the amount, or null when it is missing or not a finite number.
		 */
		function walletAmount(wallet) {
			const raw = typeof wallet.balance === 'string' ? wallet.balance.trim() : '';
			if (raw === '') return null;
			const value = Number(raw);
			return Number.isFinite(value) ? value : null;
		}

		/**
		 * Rendering text for one wallet list: zero wallets are dropped, the rest
		 * show exactly two fraction digits.
		 * @param wallets - [{ currency, balance }] wallet rows.
		 * @returns joined text, or "" when the list is empty or all zero.
		 */
		function moneyText(wallets) {
			if (!Array.isArray(wallets) || wallets.length === 0) return '';
			const parts = [];
			for (const wallet of wallets) {
				const value = walletAmount(wallet);
				if (value === null || Math.abs(value) < 0.005) continue;
				parts.push(currencySymbol(wallet.currency) + value.toFixed(2));
			}
			return parts.join(' · ');
		}

		/**
		 * Zero-amount text for one currency.
		 * @param currency - wallet currency code.
		 * @returns e.g. "¥0.00".
		 */
		function emptyBalanceText(currency) {
			return currencySymbol(currency) + '0.00';
		}

		/**
		 * Combined topped-up and granted totals per currency. Empty wallets and
		 * unreadable rows contribute nothing.
		 * @param normal - topped-up wallet rows.
		 * @param bonus - granted wallet rows.
		 * @returns currency → total map.
		 */
		function walletTotals(normal, bonus) {
			const totals = new Map();
			for (const wallets of [normal, bonus]) {
				if (!Array.isArray(wallets)) continue;
				for (const wallet of wallets) {
					const value = walletAmount(wallet);
					if (value === null || value <= 0) continue;
					const currency = typeof wallet.currency === 'string' && wallet.currency !== ''
						? wallet.currency
						: 'CNY';
					totals.set(currency, (totals.get(currency) ?? 0) + value);
				}
			}
			return totals;
		}

		/**
		 * First currency named by either wallet list, used when every wallet is
		 * empty so the zero text and its band agree.
		 * @param normal - topped-up wallet rows.
		 * @param bonus - granted wallet rows.
		 * @returns the first currency code, or "CNY".
		 */
		function firstWalletCurrency(normal, bonus) {
			for (const wallets of [normal, bonus]) {
				if (!Array.isArray(wallets)) continue;
				for (const wallet of wallets) {
					if (typeof wallet.currency === 'string' && wallet.currency !== '') return wallet.currency;
				}
			}
			return 'CNY';
		}

		/**
		 * The wallet the strip grades. CNY and USD are the Platform's usual
		 * currencies, so they win over an arbitrary first row.
		 * @param normal - topped-up wallet rows.
		 * @param bonus - granted wallet rows.
		 * @returns the graded currency and its combined amount.
		 */
		function primaryBalance(normal, bonus) {
			const totals = walletTotals(normal, bonus);
			const currency = totals.has('CNY')
				? 'CNY'
				: totals.has('USD')
					? 'USD'
					: totals.keys().next().value ?? firstWalletCurrency(normal, bonus);
			return { currency, total: totals.get(currency) ?? 0 };
		}

		/**
		 * Warning band for one currency.
		 * @param currency - wallet currency code.
		 * @returns the currency's thresholds, or the CNY defaults.
		 */
		function bandFor(currency) {
			return BALANCE_BANDS[currency] ?? DEFAULT_BALANCE_BAND;
		}

		/**
		 * Grade a combined balance against its currency band.
		 * @param total - combined topped-up and granted amount.
		 * @param currency - wallet currency code.
		 * @returns "ok" at or above `low`, "low" at or above `critical`,
		 * otherwise "critical".
		 */
		function balanceSeverity(total, currency) {
			const band = bandFor(currency);
			if (total >= band.low) return 'ok';
			if (total >= band.critical) return 'low';
			return 'critical';
		}

		/**
		 * Grade session token spend.
		 * @param total - combined input, cache, and output tokens.
		 * @returns "ok" below `warn`, "low" below `danger`, otherwise
		 * "critical".
		 */
		function tokenSeverity(total) {
			if (total >= TOKEN_BANDS.danger) return 'critical';
			if (total >= TOKEN_BANDS.warn) return 'low';
			return 'ok';
		}

		/**
		 * Grade remaining context.
		 * @param ratio - remaining tokens divided by the context window.
		 * @returns "ok" at or above `warn`, "low" at or above `danger`,
		 * otherwise "critical".
		 */
		function contextSeverity(ratio) {
			if (ratio >= CONTEXT_BANDS.warn) return 'ok';
			if (ratio >= CONTEXT_BANDS.danger) return 'low';
			return 'critical';
		}

		/**
		 * Colored warning dot for one severity.
		 * @param severity - "ok" | "low" | "critical", or null for none.
		 * @param key - React key.
		 * @returns the dot element, or null when severity is null.
		 */
		function severityDot(severity, key) {
			if (severity === null) return null;
			return react.createElement("span", {
				key,
				"aria-hidden": "true",
				style: {
					display: "inline-block",
					width: "6px",
					height: "6px",
					marginRight: "6px",
					borderRadius: "50%",
					background: SEVERITY_COLOR[severity],
					verticalAlign: "middle",
					flexShrink: 0,
				},
			});
		}

		/**
		 * Account balance polling source shared with the status bar.
		 * @param ctx - plugin context providing the remote account namespace and locale.
		 * @returns snapshot source, manual refresh, start and dispose handles.
		 */
		function createBalanceMonitor(ctx) {
			let snapshot = { phase: "loading", normal: [], bonus: [] };
			const listeners = new Set();
			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};
			const source = {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
			let disposed = false;
			let timer;
			let inFlight = false;
			const clientMetadata = () => ({
				version: releaseVersion(),
				locale: ctx.locale.getSnapshot().active,
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
			});
			const refresh = async () => {
				if (disposed || inFlight) return;
				inFlight = true;
				try {
					const result = await ctx.remote.account.getBalance(clientMetadata());
					if (disposed) return;
					if (!result || !result.ok) {
						publish({ phase: "error", normal: [], bonus: [] });
						return;
					}
					const value = result.value;
					if (value === null) {
						publish({ phase: "signed-out", normal: [], bonus: [] });
					} else if (value.status === "ready") {
						publish({
							phase: "ready",
							normal: Array.isArray(value.value) ? value.value : [],
							bonus: Array.isArray(value.bonusWallets) ? value.bonusWallets : [],
						});
					} else {
						publish({ phase: "error", normal: [], bonus: [] });
					}
				} catch (_balanceCallFailure) {
					if (!disposed) publish({ phase: "error", normal: [], bonus: [] });
				} finally {
					inFlight = false;
				}
			};
			const onVisible = () => {
				if (typeof document !== "undefined" && document.visibilityState === "visible") void refresh();
			};
			const start = () => {
				void refresh();
				timer = window.setInterval(() => {
					void refresh();
				}, REFRESH_MS);
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
			};
			const dispose = () => {
				disposed = true;
				if (timer !== undefined) window.clearInterval(timer);
				if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
				listeners.clear();
			};
			return { source, refresh, start, dispose };
		}

		/**
		 * The Session the main view currently shows; a row retains it under the
		 * mainView source while it is open.
		 * @param state - Session list snapshot.
		 * @returns current Session id, or null when no Session is open.
		 */
		function currentSessionId(state) {
			for (const id of state.ids) {
				const summary = state.byId[id];
				if (summary && (summary.retainedBy.mainView ?? 0) > 0) return id;
			}
			return null;
		}

		/**
		 * One live provider-usage projection of the current Session, or undefined.
		 * @param state - Session list snapshot.
		 * @param key - projection key.
		 * @returns the projection value when the Session has it.
		 */
		function currentProjection(state, key) {
			const id = currentSessionId(state);
			if (id === null) return undefined;
			const row = state.projectionsBySession[id];
			if (row === undefined) return undefined;
			return row.values[key];
		}

		/**
		 * Full-width status strip: account balance on the left, the current
		 * Session's token usage and remaining context on the right.
		 * @param props - locale `t` seat, the injected balance hook, the standard
		 * Session-list hook, and the manual refresh callback.
		 * @returns the strip element.
		 */
		function BalanceBar(props) {
			const t = props.t;
			const useBalance = props.useBalance;
			const useSessions = props.useSessions;
			const balance = useBalance((value) => value);
			const sessionId = useSessions((state) => currentSessionId(state));
			const usage = useSessions((state) => currentProjection(state, "tokenUsage"));
			const pressure = useSessions((state) => currentProjection(state, "contextPressure"));

			let balanceText;
			let severity = null;
			let bandHint = "";
			if (balance === undefined || balance === null || balance.phase === "loading") {
				balanceText = t("loading");
			} else if (balance.phase === "signed-out") {
				balanceText = t("notSignedIn");
			} else if (balance.phase === "error") {
				balanceText = t("balanceFailed");
			} else {
				const primary = primaryBalance(balance.normal, balance.bonus);
				const parts = [];
				const toppedUp = moneyText(balance.normal);
				const granted = moneyText(balance.bonus);
				if (toppedUp !== "") parts.push(t("toppedUp") + " " + toppedUp);
				if (granted !== "") parts.push(t("granted") + " " + granted);
				balanceText = parts.length === 0 ? emptyBalanceText(primary.currency) : parts.join(" · ");
				const band = bandFor(primary.currency);
				severity = balanceSeverity(primary.total, primary.currency);
				bandHint = t("balanceBandHint", {
					low: currencySymbol(primary.currency) + String(band.low),
					critical: currencySymbol(primary.currency) + String(band.critical),
				});
			}
			const statusText = severity === null ? "" : t(SEVERITY_COPY[severity]);
			const balanceTitle = severity === null
				? t("clickToRetry")
				: [statusText, bandHint, t("clickToRetry")].join(" · ");
			const balanceColor = severity === null
				? "var(--dsw-alias-label-primary)"
				: SEVERITY_TEXT_COLOR[severity];
			const statusDot = severityDot(severity, "balance-severity");

			const usageSegments = [];
			if (typeof usage === "object" && usage !== null) {
				const total =
					(usage.uncachedInputTokens ?? 0) +
					(usage.cacheReadTokens ?? 0) +
					(usage.cacheWriteTokens ?? 0) +
					(usage.outputTokens ?? 0);
				const tokenLevel = Number.isFinite(total) ? tokenSeverity(total) : null;
				const text = formatTokens(total) + " " + t("tokens");
				usageSegments.push({
					key: "usage",
					label: t("usage"),
					text,
					severity: tokenLevel,
					status: tokenLevel === null ? "" : t(TOKEN_COPY[tokenLevel]),
					title: tokenLevel === null
						? text
						: [t(TOKEN_COPY[tokenLevel]), t("tokenBandHint", {
							warn: formatTokens(TOKEN_BANDS.warn),
							danger: formatTokens(TOKEN_BANDS.danger),
						})].join(" · "),
				});
			}
			if (typeof pressure === "object" && pressure !== null) {
				const window = pressure.contextWindow;
				const used = typeof pressure.projectedTokens === "number" ? pressure.projectedTokens : pressure.pressureTokens;
				if (typeof window === "number" && window > 0 && typeof used === "number" && Number.isFinite(used)) {
					const remaining = Math.max(0, window - used);
					const level = contextSeverity(remaining / window);
					const text = formatTokens(remaining) + " / " + formatTokens(window);
					usageSegments.push({
						key: "context",
						label: t("contextLeft"),
						text,
						severity: level,
						status: t(CONTEXT_COPY[level]),
						title: [t(CONTEXT_COPY[level]), t("contextBandHint", {
							warn: Math.round(CONTEXT_BANDS.warn * 100) + "%",
							danger: Math.round(CONTEXT_BANDS.danger * 100) + "%",
						})].join(" · "),
					});
				}
			}
			if (usageSegments.length === 0) {
				usageSegments.push({
					key: "none",
					label: "",
					text: sessionId === null ? t("noSession") : t("waitingUsage"),
					severity: null,
					status: "",
					title: "",
				});
			}

			const usageNodes = [];
			usageSegments.forEach((segment, index) => {
				if (index > 0) usageNodes.push(react.createElement("span", { key: "sep" + String(index), style: { opacity: 0.5 } }, "·"));
				const color = segment.severity === null
					? "var(--dsw-alias-label-tertiary)"
					: SEVERITY_TEXT_COLOR[segment.severity];
				if (segment.label === "") {
					usageNodes.push(react.createElement("span", {
						key: segment.key,
						title: segment.title,
						"data-usage-severity": "unknown",
						style: { color },
					}, segment.text));
					return;
				}
				usageNodes.push(react.createElement(
					"span",
					{
						key: segment.key,
						title: segment.title,
						"aria-label": t("metricAria", { status: segment.status, value: segment.text }),
						"data-usage-severity": segment.severity ?? "unknown",
						style: {
							display: "inline-flex",
							alignItems: "center",
							minWidth: 0,
							overflow: "hidden",
						},
					},
					react.createElement("span", {
						style: {
							color: "var(--dsw-alias-label-tertiary)",
							marginRight: "6px",
							flexShrink: 0,
						},
					}, segment.label),
					severityDot(segment.severity, segment.key + "-dot"),
					react.createElement("span", {
						style: {
							color,
							minWidth: 0,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						},
					}, segment.text),
				));
			});

			return react.createElement(
				"div",
				{
					role: "status",
					"data-dsh-balance-tokens": "",
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "16px",
						height: "26px",
						padding: "0 14px",
						borderTop: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-layer-1)",
						color: "var(--dsw-alias-label-secondary)",
						fontSize: "12px",
						lineHeight: "16px",
						whiteSpace: "nowrap",
						overflow: "hidden",
						fontVariantNumeric: "tabular-nums",
						flexShrink: 0,
						userSelect: "none",
					},
				},
				react.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
					react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, t("balance")),
					react.createElement(
						"span",
						{
							title: balanceTitle,
							"aria-label": severity === null
								? balanceText
								: t("metricAria", { status: statusText, value: balanceText }),
							"data-balance-severity": severity ?? "unknown",
							onClick: () => {
								props.refresh();
							},
							style: {
								color: balanceColor,
								cursor: "pointer",
								overflow: "hidden",
								textOverflow: "ellipsis",
							},
						},
						statusDot,
						balanceText,
					),
				),
				react.createElement(
					"div",
					{
						style: {
							display: "flex",
							alignItems: "center",
							gap: "6px",
							minWidth: 0,
							overflow: "hidden",
							color: "var(--dsw-alias-label-tertiary)",
						},
					},
					usageNodes,
				),
			);
		}

		const inject = ["slots", "remote", "remote.account", "locale"];

		/**
		 * Register the strip into the frame's full-width bottom seat and own its
		 * account polling and bilingual dictionaries.
		 * @param ctx - plugin context.
		 */
		function apply(ctx) {
			const monitor = createBalanceMonitor(ctx);
			ctx.effect(
				() => {
					monitor.start();
					return () => {
						monitor.dispose();
					};
				},
				"balance-tokens: balance polling",
			);
			ctx.effect(() => ctx.locale.register(NS, "zh", zh), "balance-tokens: zh dictionary");
			ctx.effect(() => ctx.locale.register(NS, "en", en), "balance-tokens: en dictionary");

			ctx.slots.inject("shell.bottom", () =>
				ctx.slots.register(
					{
						name: "shell.bottom",
						locale: NS,
						inject: () => ({
							hooks: { balance: monitor.source },
							refresh: () => {
								void monitor.refresh();
							},
						}),
					},
					BalanceBar,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
