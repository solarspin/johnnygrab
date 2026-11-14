// JohnnyGrab helper tool. Every subcommand prints exactly one JSON line to stdout.
//
//   johnnygrab-tool info  <file>
//   johnnygrab-tool video <in.mov> <out.mp4> <header|search|preview> <seconds> [--target iphone|ipad]
//   johnnygrab-tool shot  <in.png> <out.png> [--rotate left|right]
//   johnnygrab-tool thumb <video-or-image> <out.jpg>
//
// Video export uses the macOS 26+ path: AVVideoComposition.Configuration feeding an
// AVAssetReaderVideoCompositionOutput, read with AVAssetReader.outputProvider(for:) and written
// with AVAssetWriter.inputReceiver(for:). The older addOutput / copyNextSampleBuffer /
// addInput / append / markAsFinished calls and AVMutableVideoComposition are deprecated.
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Output

struct ToolError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message])
    exit(1)
}

/// Lets a non-Sendable reader provider or writer receiver move into one child task.
/// Each box is used by exactly one task, so there is no shared mutable access.
final class Box<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

// MARK: - Crop math (ported unchanged from the proven storevideo.swift prototype)

struct Plan {
    var cropW: Double, cropH: Double, outW: Double, outH: Double
}

func plan(kind: String, w: Double, h: Double, target: String) -> Plan {
    switch kind {
    case "header":
        // Exactly 3840x1646: widest 3840:1646 strip, centered.
        var cropW = w, cropH = (w * 1646 / 3840).rounded()
        if cropH > h { cropH = h; cropW = (h * 3840 / 1646).rounded() }
        return Plan(cropW: cropW, cropH: cropH, outW: 3840, outH: 1646)
    case "search":
        // 3:2, from 1920x1280 to 3840x2560. Height a multiple of 4 keeps both sides even.
        let cropH = (min(h, w * 2 / 3) / 4).rounded(.down) * 4
        let cropW = cropH * 3 / 2
        let outW = min(max(cropW, 1920), 3840)
        return Plan(cropW: cropW, cropH: cropH, outW: outW, outH: outW * 2 / 3)
    default:
        // App Preview: largest centered crop of the target aspect, scaled to the target size.
        // Portrait output when the recording is portrait.
        var tw: Double = target == "ipad" ? 1600 : 1920
        var th: Double = target == "ipad" ? 1200 : 886
        if h > w { swap(&tw, &th) }
        var cropW = w, cropH = (w * th / tw).rounded()
        if cropH > h { cropH = h; cropW = (h * tw / th).rounded() }
        return Plan(cropW: cropW, cropH: cropH, outW: tw, outH: th)
    }
}

// MARK: - video

func exportVideo(input: URL, output: URL, kind: String, seconds: Double, target: String?) async throws -> [String: Any] {
    let asset = AVURLAsset(url: input)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ToolError("no video track in \(input.lastPathComponent)") }
    let natural = try await track.load(.naturalSize)
    let transform = try await track.load(.preferredTransform)
    let r = CGRect(origin: .zero, size: natural).applying(transform)
    let w = abs(r.width), h = abs(r.height)
    let duration = try await asset.load(.duration).seconds
    guard duration >= seconds else { throw ToolError("recording is only \(String(format: "%.2f", duration)) s, need \(seconds) s") }

    // Without --target, guess by shape: tall/wide phone screens are iPhone class, squarer ones iPad.
    let previewTarget = target ?? (max(w, h) / min(w, h) >= 1.6 ? "iphone" : "ipad")
    let p = plan(kind: kind, w: w, h: h, target: previewTarget)

    var t = transform.concatenating(CGAffineTransform(translationX: -r.minX, y: -r.minY))
    t = t.concatenating(CGAffineTransform(translationX: -(w - p.cropW) / 2, y: -(h - p.cropH) / 2))
    t = t.concatenating(CGAffineTransform(scaleX: p.outW / p.cropW, y: p.outH / p.cropH))

    let length = CMTime(seconds: seconds, preferredTimescale: 600)
    let range = CMTimeRange(start: .zero, duration: length)
    let frameDuration = CMTime(value: 1, timescale: 30)

    var layer = AVVideoCompositionLayerInstruction.Configuration(assetTrack: track)
    layer.setTransform(t, at: .zero)
    let instruction = AVVideoCompositionInstruction(configuration: .init(layerInstructions: [AVVideoCompositionLayerInstruction(configuration: layer)], timeRange: range))
    let composition = AVVideoComposition(configuration: .init(
        colorPrimaries: AVVideoColorPrimaries_ITU_R_709_2,
        colorTransferFunction: AVVideoTransferFunction_ITU_R_709_2,
        colorYCbCrMatrix: AVVideoYCbCrMatrix_ITU_R_709_2,
        frameDuration: frameDuration,
        instructions: [instruction],
        renderSize: CGSize(width: p.outW, height: p.outH)))

    // Reader
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = range
    let readerOutput = AVAssetReaderVideoCompositionOutput(videoTracks: [track], videoSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ])
    readerOutput.videoComposition = composition
    guard reader.canAdd(readerOutput) else { throw ToolError("reader cannot add the composition output") }
    let provider = reader.outputProvider(for: readerOutput)

    // Writer
    try? FileManager.default.removeItem(at: output)
    let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true  // moov atom first: progressive
    // Moving moov to the front makes the writer spill temp files ("<out>.sb-*"). Give it its own
    // folder next to the output and remove it, plus any stray "<out>.sb-*", when the export ends.
    // Keeping it beside the output means a killed export leaves it in the caller's temp folder.
    let scratch = output.deletingLastPathComponent().appendingPathComponent(".johnnygrab-writer-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    writer.directoryForTemporaryFiles = scratch
    defer { cleanWriterTemp(scratch: scratch, output: output) }
    let isPreview = kind == "preview"
    let bitRate = isPreview ? 11_000_000 : 40_000_000
    let compression: [String: Any] = [
        AVVideoAverageBitRateKey: bitRate,
        AVVideoProfileLevelKey: isPreview ? AVVideoProfileLevelH264High40 : AVVideoProfileLevelH264HighAutoLevel,
        AVVideoExpectedSourceFrameRateKey: 30,
        AVVideoMaxKeyFrameIntervalKey: 30,
        AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
    ]
    let videoSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Int(p.outW),
        AVVideoHeightKey: Int(p.outH),
        AVVideoCompressionPropertiesKey: compression,
        AVVideoColorPropertiesKey: [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
    ]
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    guard writer.canAdd(videoInput) else { throw ToolError("writer cannot add the H.264 video input") }
    let videoReceiver = writer.inputReceiver(for: videoInput)

    // App Previews need a stereo AAC track. Simulator recordings have none, so write silence.
    let sampleRate = 48_000.0
    var audioReceiver: AVAssetWriterInput.SampleBufferReceiver?
    var audioFormat: CMAudioFormatDescription?
    if isPreview {
        var layout = AudioChannelLayout()
        layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 256_000,
            AVEncoderBitRateStrategyKey: AVAudioBitRateStrategy_Constant,  // silence would otherwise encode at ~2 kbps
            AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
        ]
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        guard writer.canAdd(audioInput) else { throw ToolError("writer cannot add the AAC audio input") }
        audioReceiver = writer.inputReceiver(for: audioInput)
        let pcm = AudioStreamBasicDescription(
            mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
        audioFormat = try CMAudioFormatDescription(audioStreamBasicDescription: pcm)
    }

    try reader.start()
    try writer.start()
    writer.startSession(atSourceTime: .zero)

    let providerBox = Box(provider), videoBox = Box(videoReceiver)
    let audioBox = audioReceiver.map { Box($0) }
    let formatBox = audioFormat.map { Box($0) }
    let totalFrames = Int((seconds * sampleRate).rounded())

    let frames = try await withThrowingTaskGroup(of: Int.self) { group in
        group.addTask {
            // The simulator only sends a frame when the screen changes, and the composition
            // output follows those source frames. Resample onto a strict 1/30 s grid: every slot
            // gets the latest frame shown at that moment.
            let slots = Int((seconds * 30).rounded())
            var slot = 0
            var held: CMReadySampleBuffer<CVReadOnlyPixelBuffer>?
            func emit(_ frame: CMReadySampleBuffer<CVReadOnlyPixelBuffer>) async throws {
                var copy = frame
                copy.presentationTimeStamp = CMTime(value: CMTimeValue(slot), timescale: 30)
                copy.duration = frameDuration
                try await videoBox.value.append(CMReadySampleBuffer<CMSampleBuffer.DynamicContent>(copy))
                slot += 1
            }
            while let buffer = try await providerBox.value.next() {
                guard let frame = CMReadySampleBuffer<CVReadOnlyPixelBuffer>(buffer) else { continue }
                if let current = held {
                    while slot < slots, CMTime(value: CMTimeValue(slot), timescale: 30) < frame.presentationTimeStamp {
                        try await emit(current)
                    }
                }
                held = frame
            }
            guard let last = held else { throw ToolError("the composition produced no frames") }
            while slot < slots { try await emit(last) }
            videoBox.value.finish()
            return slot
        }
        if let audioBox, let formatBox {
            group.addTask {
                let chunk = 4_800  // 0.1 s per buffer
                var written = 0
                while written < totalFrames {
                    let n = min(chunk, totalFrames - written)
                    let block = CMReadOnlyDataBlockBuffer(Data(count: n * 4))
                    let pcmBuffer = CMReadySampleBuffer<CMReadOnlyDataBlockBuffer>(
                        audioDataBuffer: block, formatDescription: formatBox.value, sampleCount: n,
                        presentationTimeStamp: CMTime(value: CMTimeValue(written), timescale: CMTimeScale(sampleRate)))
                    try await audioBox.value.append(CMReadySampleBuffer<CMSampleBuffer.DynamicContent>(pcmBuffer))
                    written += n
                }
                audioBox.value.finish()
                return 0
            }
        }
        var videoFrames = 0
        for try await n in group { videoFrames += n }
        return videoFrames
    }

    writer.endSession(atSourceTime: length)
    await writer.finishWriting()
    if writer.status != .completed {
        throw ToolError("writer failed: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")")
    }
    if reader.status == .failed {
        throw ToolError("reader failed: \(reader.error?.localizedDescription ?? "unknown")")
    }
    return [
        "ok": true, "output": output.path, "kind": kind,
        "recorded": "\(Int(w))x\(Int(h))", "crop": "\(Int(p.cropW))x\(Int(p.cropH))",
        "width": Int(p.outW), "height": Int(p.outH), "seconds": seconds, "frames": frames,
        "target": isPreview ? previewTarget : NSNull(),
    ]
}

func cleanWriterTemp(scratch: URL, output: URL) {
    let fm = FileManager.default
    try? fm.removeItem(at: scratch)
    let dir = output.deletingLastPathComponent()
    let prefix = output.lastPathComponent + ".sb-"
    for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix(prefix) {
        try? fm.removeItem(at: dir.appendingPathComponent(name))
    }
}

// MARK: - info

func fourCC(_ code: FourCharCode) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }
    return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespaces)
}

func h264ProfileName(_ profile: UInt8) -> String {
    switch profile {
    case 66: return "Baseline"
    case 77: return "Main"
    case 100: return "High"
    default: return "profile \(profile)"
    }
}

func imageInfo(_ url: URL) -> [String: Any]? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0,
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
    return [
        "ok": true, "type": "image", "file": url.path,
        "width": props[kCGImagePropertyPixelWidth] as? Int ?? 0,
        "height": props[kCGImagePropertyPixelHeight] as? Int ?? 0,
        "hasAlpha": props[kCGImagePropertyHasAlpha] as? Bool ?? false,
        "format": (CGImageSourceGetType(source) as String?) ?? "unknown",
    ]
}

func videoInfo(_ url: URL) async throws -> [String: Any] {
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    var result: [String: Any] = ["ok": true, "type": "video", "file": url.path, "duration": duration]
    if let track = try await asset.loadTracks(withMediaType: .video).first {
        let (natural, transform, nominal, rate, formats) = try await track.load(
            .naturalSize, .preferredTransform, .nominalFrameRate, .estimatedDataRate, .formatDescriptions)
        let r = CGRect(origin: .zero, size: natural).applying(transform)
        result["width"] = Int(abs(r.width).rounded())
        result["height"] = Int(abs(r.height).rounded())
        result["nominalFps"] = Double(nominal)
        result["videoBitRate"] = Int(rate)
        if let format = formats.first {
            result["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
            if let atoms = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
               let avcC = atoms["avcC"] as? Data, avcC.count >= 4 {
                let bytes = [UInt8](avcC)
                result["profile"] = h264ProfileName(bytes[1])
                result["level"] = Double(bytes[3]) / 10
            }
        }
        // Count real frames so a constant 30 fps can be checked, not just the nominal rate.
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        if reader.canAdd(output) {
            let provider = reader.outputProvider(for: output)
            try reader.start()
            var times: [Double] = []
            while let buffer = try await provider.next() {
                if buffer.sampleCount > 0 { times.append(buffer.presentationTimeStamp.seconds) }
            }
            times.sort()
            let deltas = zip(times.dropFirst(), times).map { $0 - $1 }
            result["frameCount"] = times.count
            if let lo = deltas.min(), let hi = deltas.max() {
                result["minFrameMs"] = (lo * 1000 * 100).rounded() / 100
                result["maxFrameMs"] = (hi * 1000 * 100).rounded() / 100
            }
        }
    }
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    result["audioTracks"] = audioTracks.count
    if let audio = audioTracks.first {
        let (formats, rate, enabled) = try await audio.load(.formatDescriptions, .estimatedDataRate, .isEnabled)
        result["audioBitRate"] = Int(rate)
        result["audioEnabled"] = enabled
        if let format = formats.first, let asbd = format.audioStreamBasicDescription {
            result["audioChannels"] = Int(asbd.mChannelsPerFrame)
            result["audioSampleRate"] = asbd.mSampleRate
            result["audioCodec"] = fourCC(asbd.mFormatID)
        }
    }
    return result
}

// MARK: - shot

func writeImage(_ image: CGImage, to url: URL, type: UTType, properties: [CFString: Any] = [:]) throws {
    try? FileManager.default.removeItem(at: url)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
        throw ToolError("cannot create \(url.lastPathComponent)")
    }
    CGImageDestinationAddImage(dest, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw ToolError("cannot write \(url.lastPathComponent)") }
}

func shot(input: URL, output: URL, rotate: String?) throws -> [String: Any] {
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw ToolError("cannot read \(input.lastPathComponent)") }
    let srcW = image.width, srcH = image.height
    let turn = rotate == "left" || rotate == "right"
    let w = turn ? srcH : srcW, h = turn ? srcW : srcH
    let space = (image.colorSpace?.model == .rgb ? image.colorSpace : nil) ?? CGColorSpace(name: CGColorSpace.sRGB)!
    // noneSkipLast: 8-bit RGB with an ignored fourth byte, so the PNG has no alpha channel.
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw ToolError("cannot make bitmap") }
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if rotate == "left" {         // 90 degrees counterclockwise
        ctx.translateBy(x: 0, y: CGFloat(h)); ctx.rotate(by: -.pi / 2)
    } else if rotate == "right" { // 90 degrees clockwise
        ctx.translateBy(x: CGFloat(w), y: 0); ctx.rotate(by: .pi / 2)
    }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: srcW, height: srcH))
    guard let flat = ctx.makeImage(), let data = ctx.data else { throw ToolError("cannot flatten image") }

    // Near-all-black check (a Duo panel that isn't showing captures black).
    let pixels = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
    var lit = 0
    for i in stride(from: 0, to: w * h * 4, by: 4) where max(pixels[i], pixels[i + 1], pixels[i + 2]) > 24 {
        lit += 1
    }
    let litFraction = Double(lit) / Double(w * h)
    try writeImage(flat, to: output, type: .png)
    return ["ok": true, "output": output.path, "width": w, "height": h, "hasAlpha": false,
            "black": litFraction < 0.002, "litFraction": (litFraction * 10_000).rounded() / 10_000,
            "rotated": rotate ?? NSNull()]
}

// MARK: - thumb

func thumb(input: URL, output: URL) async throws -> [String: Any] {
    let image: CGImage
    if let source = CGImageSourceCreateWithURL(input as CFURL, nil), CGImageSourceGetCount(source) > 0,
       let type = CGImageSourceGetType(source) as String?, UTType(type)?.conforms(to: .image) == true {
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                        kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: 640]
        guard let t = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw ToolError("cannot thumbnail image") }
        image = t
    } else {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: input))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 10)
        image = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
    }
    try writeImage(image, to: output, type: .jpeg, properties: [kCGImageDestinationLossyCompressionQuality: 0.8])
    return ["ok": true, "output": output.path, "width": image.width, "height": image.height]
}

// MARK: - Main

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let value = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return value
}
let target = option("--target")
let rotate = option("--rotate")
let usage = "usage: johnnygrab-tool info <file> | video <in> <out.mp4> <header|search|preview> <seconds> [--target iphone|ipad] | shot <in> <out.png> [--rotate left|right] | thumb <in> <out.jpg>"
guard let command = args.first else { fail(usage) }

if ["video", "shot", "thumb"].contains(command), args.count > 1, !FileManager.default.fileExists(atPath: args[1]) {
    fail("no such file: \(args[1])")
}

do {
    switch command {
    case "info" where args.count == 2:
        let url = URL(fileURLWithPath: args[1])
        guard FileManager.default.fileExists(atPath: url.path) else { fail("no such file: \(url.path)") }
        if let info = imageInfo(url), (info["width"] as? Int ?? 0) > 0 {
            emit(info)
        } else {
            emit(try await videoInfo(url))
        }
    case "video" where args.count == 5:
        guard ["header", "search", "preview"].contains(args[3]) else { fail("kind must be header, search or preview") }
        guard let seconds = Double(args[4]), seconds > 0, seconds <= 60 else { fail("seconds must be a number from 1 to 60") }
        if let target, !["iphone", "ipad"].contains(target) { fail("--target must be iphone or ipad") }
        emit(try await exportVideo(input: URL(fileURLWithPath: args[1]), output: URL(fileURLWithPath: args[2]),
                                   kind: args[3], seconds: seconds, target: target))
    case "shot" where args.count == 3:
        if let rotate, !["left", "right"].contains(rotate) { fail("--rotate must be left or right") }
        emit(try shot(input: URL(fileURLWithPath: args[1]), output: URL(fileURLWithPath: args[2]), rotate: rotate))
    case "thumb" where args.count == 3:
        emit(try await thumb(input: URL(fileURLWithPath: args[1]), output: URL(fileURLWithPath: args[2])))
    default:
        fail(usage)
    }
} catch {
    fail(String(describing: error))
}
