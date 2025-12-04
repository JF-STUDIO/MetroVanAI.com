export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* 顶部导航 */}
      <header className="border-b border-slate-100">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-white text-sm font-semibold">
              M
            </div>
            <span className="text-sm font-semibold text-slate-900">MetroVan AI</span>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-slate-600 md:flex">
            <a href="/" className="hover:text-slate-900">
              首页
            </a>
            <a href="/dashboard" className="hover:text-slate-900">
              AI工作室
            </a>
            <span className="text-slate-900 font-medium">充值中心</span>
          </nav>
          <div className="flex items-center gap-2 text-sm">
            <a
              href="/auth"
              className="rounded-full px-3 py-1 text-slate-600 hover:bg-slate-50"
            >
              登录
            </a>
            <a
              href="/auth"
              className="rounded-full bg-blue-600 px-4 py-1.5 text-white shadow-sm hover:bg-blue-700"
            >
              注册
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 md:px-6 py-10 pb-24">
        <div className="mb-10 text-center">
          <h1 className="mb-2 text-3xl font-semibold">简单的定价，按需购买</h1>
          <p className="text-sm text-slate-600">
            点数永久有效，随时使用。1 点 = 1 张精修图。
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {/* 按需充值 */}
          <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-1 text-xs font-medium text-slate-500">按需充值</p>
            <p className="mb-4 text-xs text-slate-500">适合偶尔使用的用户，灵活自由。</p>
            <div className="mb-4">
              <div className="text-xs text-slate-500">单价</div>
              <div className="text-2xl font-semibold">$0.30<span className="ml-1 text-sm font-normal text-slate-500">/ 张</span></div>
            </div>
            <label className="mb-1 text-xs text-slate-600">输入购买数量</label>
            <input
              type="number"
              min={1}
              defaultValue={10}
              className="mb-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="mb-4 text-sm font-medium text-slate-900">总计金额 $3.00</div>
            <a
              href="/auth?mode=signup"
              className="mt-auto inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-black"
            >
              立即充值
            </a>
            <ul className="mt-4 space-y-1 text-xs text-slate-500">
              <li>· 自定义购买数量</li>
              <li>· 无最低消费限制</li>
            </ul>
          </div>

          {/* 专业包 */}
          <div className="relative flex flex-col rounded-2xl border border-blue-500 bg-blue-50/40 p-6 shadow-md">
            <div className="absolute right-4 top-4 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white">
              热销推荐
            </div>
            <p className="mb-1 text-xs font-medium text-slate-600">专业包</p>
            <p className="mb-4 text-xs text-slate-500">适合独立经纪人和摄影师。</p>
            <div className="mb-2">
              <div className="text-2xl font-semibold">
                $125<span className="ml-1 text-sm font-normal text-slate-500">/ 500 点</span>
              </div>
              <div className="text-xs text-green-600">单价 $0.25 / 张（省 17%）</div>
            </div>
            <a
              href="/auth?mode=signup"
              className="mt-4 inline-flex items-center justify-center rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              购买 500 点数
            </a>
            <ul className="mt-4 space-y-1 text-xs text-slate-600">
              <li>· 含约 500 张修图额度</li>
              <li>· 优先处理通道</li>
              <li>· 点数永久不过期</li>
            </ul>
          </div>

          {/* 机构包 */}
          <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-1 text-xs font-medium text-slate-500">机构包</p>
            <p className="mb-4 text-xs text-slate-500">适合大量图像的团队和机构。</p>
            <div className="mb-2">
              <div className="text-2xl font-semibold">
                $200<span className="ml-1 text-sm font-normal text-slate-500">/ 1000 点</span>
              </div>
              <div className="text-xs text-green-600">单价 $0.20 / 张（省 33%）</div>
            </div>
            <a
              href="/auth?mode=signup"
              className="mt-4 inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-black"
            >
              购买 1000 点数
            </a>
            <ul className="mt-4 space-y-1 text-xs text-slate-600">
              <li>· 含约 1000 张修图额度</li>
              <li>· 精准并发处理</li>
              <li>· 专属客户经理支持</li>
            </ul>
          </div>
        </div>

        <p className="mt-10 text-center text-[11px] text-slate-500">
          支持 Visa、Mastercard、PayPal 等主流支付方式。如需购买更高点数套餐，请联系 sales@propvision.ai 获取优惠方案。
        </p>
      </main>
    </div>
  )
}
