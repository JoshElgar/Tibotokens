// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "Tibotokens",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Tibotokens", targets: ["Tibotokens"]),
    ],
    targets: [
        .executableTarget(name: "Tibotokens"),
    ]
)
