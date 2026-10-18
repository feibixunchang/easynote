import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        // 状态栏（时间 / 信号 / WiFi / 电量）那一行由窗口底色兜底。
        // 不设置的话，WebView 没覆盖到的部分会露出系统默认的灰底 → 与白色页面形成色差。
        window?.backgroundColor = .white
        if let bridge = window?.rootViewController as? CAPBridgeViewController {
            bridge.view.backgroundColor = .white
            // webView 在 viewDidLoad 里才创建，延后一帧再取
            DispatchQueue.main.async {
                if let wv = bridge.webView {
                    wv.isOpaque = true
                    wv.backgroundColor = .white
                    wv.scrollView.backgroundColor = .white
                    // iOS 26 起，滚动容器顶部可能带一层系统"边缘模糊"，会把状态栏区域
                    // 渲染成灰渐变且不受 CSS 影响；若该 API 存在（运行时判断，不依赖 SDK 版本）就关掉。
                    let edgeSel = NSSelectorFromString("topEdgeEffect")
                    if wv.scrollView.responds(to: edgeSel),
                       let eff = wv.scrollView.perform(edgeSel)?.takeUnretainedValue() as? NSObject,
                       eff.responds(to: NSSelectorFromString("setHidden:")) {
                        eff.setValue(true, forKey: "hidden")
                    }
                }
            }
        }

        // 兜底：系统有时会在状态栏位置盖一层毛玻璃（UIVisualEffectView），
        // 表现为「页面是白的、状态栏那一行是灰的，改 CSS 无效」。
        // 这里把顶部薄薄一条里的模糊视图隐藏掉（只动高度很小、贴顶的那种）。
        for delay in [0.4, 1.2, 2.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let win = self?.window else { return }
                SceneDelegate.hideTopBlurViews(in: win)
            }
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// 递归隐藏「贴顶且很薄」的毛玻璃视图（状态栏那层系统材质），其它模糊背景不动。
    static func hideTopBlurViews(in view: UIView) {
        for sub in view.subviews {
            if sub is UIVisualEffectView {
                let f = sub.frame
                if f.minY <= 1, f.height > 0, f.height <= 160 {
                    sub.isHidden = true
                }
            }
            hideTopBlurViews(in: sub)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
