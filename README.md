# dsh-plugin-balance-tokens
dsh-plugin-balance-tokens 是 DSH Web GUI 的纯 UI 插件,在底部 shell.bottom 注册全宽状态条。左侧显示 DeepSeek 充值余额与赠送余额,点击手动刷新、每 60 秒自动刷新、页面可见时刷新,余额经 Host 的 account/getBalance RPC 获取,前端不接触凭据。右侧显示当前会话 token 用量与上下文剩余(contextWindow - projectedTokens);无会话显示「无活动会话」,无用量显示「等待用量数据」。文案经 balance-tokens locale 随中英文界面切换。
