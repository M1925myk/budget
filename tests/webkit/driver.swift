// Запускает страницу в настоящем движке WebKit (системная библиотека macOS) без окна на экране и без
// изменения настроек Safari. Сценарий (асинхронный JavaScript) приходит файлом, результат печатается как JSON.
// Аргументы: адрес страницы, файл сценария, файл для снимка экрана.
import Cocoa
import WebKit

let arguments = CommandLine.arguments
guard arguments.count == 4, let pageURL = URL(string: arguments[1]) else {
  fputs("Нужны аргументы: адрес, сценарий, снимок\n", stderr)
  exit(2)
}
let scenario = try String(contentsOfFile: arguments[2], encoding: .utf8)
let shotPath = arguments[3]

final class Runner: NSObject, WKNavigationDelegate {
  let webView: WKWebView
  init(webView: WKWebView) {
    self.webView = webView
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.callAsyncJavaScript(scenario, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .success(let value):
        print(value as? String ?? "null")
      case .failure(let error):
        print("{\"driverError\":\(String(reflecting: String(describing: error)))}")
      }
      let config = WKSnapshotConfiguration()
      webView.takeSnapshot(with: config) { image, _ in
        if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
          try? png.write(to: URL(fileURLWithPath: shotPath))
        }
        exit(0)
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    print("{\"driverError\":\(String(reflecting: String(describing: error)))}")
    exit(1)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    print("{\"driverError\":\(String(reflecting: String(describing: error)))}")
    exit(1)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let frame = NSRect(x: 0, y: 0, width: 430, height: 932)
let webView = WKWebView(frame: frame, configuration: configuration)
let window = NSWindow(contentRect: frame.offsetBy(dx: -5000, dy: -5000), styleMask: .borderless, backing: .buffered, defer: false)
window.contentView = webView

let runner = Runner(webView: webView)
webView.navigationDelegate = runner
webView.load(URLRequest(url: pageURL))

DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
  print("{\"driverError\":\"таймаут 60 секунд\"}")
  exit(1)
}
app.run()
