import Foundation

// Deliberately uses default system trust: no URLSession delegate, custom roots,
// trust-all callback, or certificate-pinning bypass.
let arguments = CommandLine.arguments
guard arguments.count == 4, let port = Int(arguments[1]), let url = URL(string: arguments[2]) else {
    exit(2)
}
let configuration = URLSessionConfiguration.ephemeral
configuration.timeoutIntervalForRequest = 10
configuration.timeoutIntervalForResource = 15
configuration.connectionProxyDictionary = [
    "HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": port,
    "HTTPSEnable": 1, "HTTPSProxy": "127.0.0.1", "HTTPSPort": port
]
let session = URLSession(configuration: configuration)
let done = DispatchSemaphore(value: 0)
session.dataTask(with: url) { data, response, error in
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let ok = error == nil && status == 200 && String(data: data ?? Data(), encoding: .utf8) == arguments[3]
    var result: [String: Any] = ["ok": ok, "system_tls_verified": ok, "status_code": status]
    if let error = error as NSError? {
        result["error_code"] = error.code
        result["error_domain"] = error.domain
        result["message"] = error.localizedDescription
    }
    if let json = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
       let output = String(data: json, encoding: .utf8) { print(output) }
    done.signal()
}.resume()
if done.wait(timeout: .now() + 20) == .timedOut { exit(3) }
session.invalidateAndCancel()
