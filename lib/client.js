window.__ModuleLoader__.load({
	id: "dsh-plugin-balance-tokens",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		const NS = "balance-tokens";
		const REFRESH_MS = 60000;

		const zh = {
			balance: "余额",
			toppedUp: "充值",
			granted: "赠送",
			loading: "加载中…",
			notSignedIn: "账户未登录",
			balanceFailed: "余额获取失败",
			clickToRetry: "点击刷新余额",
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
		 * Rendering text for one wallet list.
		 * @param wallets - [{ currency, balance }] wallet rows.
		 * @returns joined text, or "" for an empty list.
		 */
		function moneyText(wallets) {
			if (!Array.isArray(wallets) || wallets.length === 0) return "";
			return wallets
				.map((wallet) => currencySymbol(wallet.currency) + wallet.balance)
				.join(" · ");
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
			if (balance === undefined || balance === null || balance.phase === "loading") {
				balanceText = t("loading");
			} else if (balance.phase === "signed-out") {
				balanceText = t("notSignedIn");
			} else if (balance.phase === "error") {
				balanceText = t("balanceFailed");
			} else {
				const parts = [];
				const toppedUp = moneyText(balance.normal);
				const granted = moneyText(balance.bonus);
				if (toppedUp !== "") parts.push(t("toppedUp") + " " + toppedUp);
				if (granted !== "") parts.push(t("granted") + " " + granted);
				balanceText = parts.length === 0 ? "—" : parts.join(" · ");
			}

			const usageParts = [];
			if (typeof usage === "object" && usage !== null) {
				const total =
					(usage.uncachedInputTokens ?? 0) +
					(usage.cacheReadTokens ?? 0) +
					(usage.cacheWriteTokens ?? 0) +
					(usage.outputTokens ?? 0);
				usageParts.push(t("usage") + " " + formatTokens(total) + " " + t("tokens"));
			}
			if (typeof pressure === "object" && pressure !== null) {
				const window = pressure.contextWindow;
				const used = typeof pressure.projectedTokens === "number" ? pressure.projectedTokens : pressure.pressureTokens;
				if (typeof window === "number" && window > 0 && typeof used === "number") {
					usageParts.push(t("contextLeft") + " " + formatTokens(Math.max(0, window - used)) + " / " + formatTokens(window));
				}
			}
			if (usageParts.length === 0) usageParts.push(sessionId === null ? t("noSession") : t("waitingUsage"));

			const usageNodes = [];
			usageParts.forEach((text, index) => {
				if (index > 0) usageNodes.push(react.createElement("span", { key: "sep" + String(index), style: { opacity: 0.5 } }, "·"));
				usageNodes.push(react.createElement("span", { key: "part" + String(index) }, text));
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
							title: t("clickToRetry"),
							onClick: () => {
								props.refresh();
							},
							style: {
								color: "var(--dsw-alias-label-primary)",
								cursor: "pointer",
								overflow: "hidden",
								textOverflow: "ellipsis",
							},
						},
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
