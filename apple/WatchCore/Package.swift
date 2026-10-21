// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WatchCore",
    platforms: [.macOS(.v13), .watchOS(.v10)],
    products: [.library(name: "WatchCore", targets: ["WatchCore"])],
    targets: [
        .target(name: "WatchCore"),
        .testTarget(name: "WatchCoreTests", dependencies: ["WatchCore"])
    ]
)
