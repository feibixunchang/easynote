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

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
