using System;
using System.IO;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;

using java.net;
using sun.net.spi.nameservice;
using javax.net.ssl;
using java.security.cert;
using X509Certificate = javax.security.cert.X509Certificate;
using Principal = java.security.Principal;

/// <summary>
/// Adapts a <see cref="ClientWebSocket"/> to full <see cref="Stream"/> semantics,
/// treating the WebSocket as a duplex byte stream (binary messages).
/// Each Write call is sent as one WebSocket message (or chunked to a max frame size);
/// reads reassemble across message boundaries as an endless byte stream.
/// </summary>
public sealed class WebSocketStream : Stream
{
	private readonly ClientWebSocket _socket;
	private readonly bool _ownsSocket;
	private readonly int _maxWriteChunk;

	// Buffer to hold leftover bytes from a WebSocket message that
	// didn't fully fit in the caller's read buffer.
	private readonly byte[] _readBuffer;
	private int _readOffset;
	private int _readCount;
	private bool _readClosed;

	public WebSocketStream(ClientWebSocket socket, bool ownsSocket = true, int maxWriteChunk = 64 * 1024)
	{
		_socket = socket ?? throw new ArgumentNullException(nameof(socket));
		_ownsSocket = ownsSocket;
		_maxWriteChunk = maxWriteChunk;
		_readBuffer = new byte[8192];
		_readOffset = 0;
		_readCount = 0;
	}

	public override bool CanRead => _socket.State == WebSocketState.Open || _readCount > 0;
	public override bool CanWrite => _socket.State == WebSocketState.Open;
	public override bool CanSeek => false;
	public override bool CanTimeout => true;

	public override long Length => throw new NotSupportedException("WebSocketStream does not support Length.");
	public override long Position
	{
		get => throw new NotSupportedException("WebSocketStream does not support Position.");
		set => throw new NotSupportedException("WebSocketStream does not support Position.");
	}

	public override long Seek(long offset, SeekOrigin origin) =>
		throw new NotSupportedException("WebSocketStream does not support seeking.");

	public override void SetLength(long value) =>
		throw new NotSupportedException("WebSocketStream does not support SetLength.");

	// ---------- Reading ----------

	public override int Read(byte[] buffer, int offset, int count)
		=> ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

	public override int Read(Span<byte> buffer)
	{
		// Fallback: rent an array-backed copy path via ReadAsync overload
		var rented = new byte[buffer.Length];
		int n = Read(rented, 0, rented.Length);
		rented.AsSpan(0, n).CopyTo(buffer);
		return n;
	}

	public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
	{
		ValidateBufferArgs(buffer, offset, count);
		if (count == 0) return 0;

		// Serve from any leftover buffered bytes first.
		if (_readCount > 0)
		{
			int n = Math.Min(count, _readCount);
			Array.Copy(_readBuffer, _readOffset, buffer, offset, n);
			_readOffset += n;
			_readCount -= n;
			return n;
		}

		if (_readClosed)
			return 0;

		while (true)
		{
			WebSocketReceiveResult result;
			try
			{
				result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer, offset, count), cancellationToken)
					.ConfigureAwait(false);
			}
			catch (WebSocketException wex)
			{
				throw new System.IO.IOException("WebSocket read failed.", wex);
			}

			if (result.MessageType == WebSocketMessageType.Close)
			{
				_readClosed = true;
				try
				{
					await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "ack", cancellationToken)
						.ConfigureAwait(false);
				}
				catch { /* best-effort */ }
				return 0;
			}

			if (result.Count == 0 && !result.EndOfMessage)
			{
				// Rare: zero-byte fragment, keep reading.
				continue;
			}

			return result.Count;
		}
	}

	// ---------- Writing ----------

	public override void Write(byte[] buffer, int offset, int count)
		=> WriteAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

	public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
	{
		ValidateBufferArgs(buffer, offset, count);
		if (count == 0) return;

		int written = 0;
		while (written < count)
		{
			int chunk = Math.Min(_maxWriteChunk, count - written);
			bool isLast = (written + chunk) >= count;

			try
			{
				await _socket.SendAsync(
					new ArraySegment<byte>(buffer, offset + written, chunk),
					WebSocketMessageType.Binary,
					endOfMessage: isLast,
					cancellationToken).ConfigureAwait(false);
			}
			catch (WebSocketException wex)
			{
				throw new System.IO.IOException("WebSocket write failed.", wex);
			}

			written += chunk;
		}
	}

	public override void Flush()
	{
		// WebSocket sends are not buffered on this side; nothing to flush.
	}

	public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;

	// ---------- Close/Dispose ----------

	public override void Close()
	{
		try
		{
			if (_socket.State == WebSocketState.Open || _socket.State == WebSocketState.CloseReceived)
			{
				_socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Stream closed", CancellationToken.None)
					.GetAwaiter().GetResult();
			}
		}
		catch { /* ignore close race/errors */ }
		finally
		{
			base.Close();
		}
	}

	/// <summary>
	/// Tears the socket down immediately with no close handshake. Unlike <see cref="Close"/> this
	/// never blocks, so it's safe to call from a netty event-loop thread (see IkvmWebSocketChannel).
	/// </summary>
	public void Abort()
	{
		try { _socket.Abort(); } catch { /* ignore */ }
		if (_ownsSocket)
		{
			try { _socket.Dispose(); } catch { /* ignore */ }
		}
	}

	protected override void Dispose(bool disposing)
	{
		if (disposing)
		{
			try
			{
				if (_socket.State == WebSocketState.Open || _socket.State == WebSocketState.CloseReceived)
				{
					_socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Stream disposed", CancellationToken.None)
						.GetAwaiter().GetResult();
				}
			}
			catch { /* ignore */ }

			if (_ownsSocket)
				_socket.Dispose();
		}
		base.Dispose(disposing);
	}

#if NET
	public override async ValueTask DisposeAsync()
	{
		try
		{
			if (_socket.State == WebSocketState.Open || _socket.State == WebSocketState.CloseReceived)
			{
				await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Stream disposed", CancellationToken.None)
					.ConfigureAwait(false);
			}
		}
		catch { /* ignore */ }

		if (_ownsSocket)
			_socket.Dispose();

		await base.DisposeAsync().ConfigureAwait(false);
	}
#endif

	private static void ValidateBufferArgs(byte[] buffer, int offset, int count)
	{
		if (buffer == null) throw new ArgumentNullException(nameof(buffer));
		if (offset < 0 || count < 0 || offset + count > buffer.Length)
			throw new ArgumentOutOfRangeException(nameof(count));
	}
}

static class IkvmNetworkState
{
	static readonly List<string> FakeDnsResolves = [];

	private static (byte, byte, byte, byte) GetIPFromIndex(int index)
	{
		if (index / byte.MaxValue > byte.MaxValue) throw new ArgumentOutOfRangeException("index too large");
		if (index < 0) throw new ArgumentOutOfRangeException("index below zero");

		return (240, 67, (byte)(index / byte.MaxValue), (byte)(index % byte.MaxValue));
	}
	private static int GetIndexFromIP((byte, byte, byte, byte) ip)
	{
		return ip.Item3 * byte.MaxValue + ip.Item4;
	}

	internal static (byte, byte, byte, byte) GetFakeIP(string host)
	{
		lock (FakeDnsResolves)
		{
			var idx = FakeDnsResolves.FindIndex(x => x == host);
			if (idx < 0)
			{
				idx = FakeDnsResolves.Count;
				FakeDnsResolves.Add(host);
			}
			return GetIPFromIndex(idx);
		}
	}

	internal static string GetHostFromFakeIP((byte, byte, byte, byte) ip)
	{
		lock (FakeDnsResolves)
		{
			return FakeDnsResolves[GetIndexFromIP(ip)];
		}
	}

	// Map an address back to the original hostname: one of IkvmNameService's synthetic 240.67.x.y
	// IPs resolves to the host it was minted for; anything else (e.g. a literal IP that never went
	// through our resolver) falls back to its own hostname.
	internal static string ResolveHost(InetAddress addr)
	{
		var ip = addr.getAddress();
		if (ip != null && ip.Length == 4)
		{
			try { return GetHostFromFakeIP((ip[0], ip[1], ip[2], ip[3])); }
			catch { }
		}
		return addr.getHostName();
	}

	// Resolve a socket address to the (host, port) the proxy should dial.
	internal static (string host, int port) ResolveTarget(SocketAddress remote)
	{
		var isa = (InetSocketAddress)remote;
		int port = isa.getPort();
		var addr = isa.getAddress();
		return (addr != null ? ResolveHost(addr) : isa.getHostString(), port);
	}
}

public class IkvmNameService : NameService
{
	public static void Install()
	{
		_ = InetAddress.getByAddress([240, 0, 0, 0]);

		var field = typeof(InetAddress).GetField("nameServices", BindingFlags.Static | BindingFlags.NonPublic);
		field.SetValue(null, java.util.Arrays.asList(new IkvmNameService()));
	}

	public InetAddress[] lookupAllHostAddr(string host)
	{
		var (a, b, c, d) = IkvmNetworkState.GetFakeIP(host);
		return [InetAddress.getByAddress([a, b, c, d])];
	}

	public string getHostByAddr(byte[] addr)
	{
		var address = (addr[0], addr[1], addr[2], addr[3]);
		try
		{
			return IkvmNetworkState.GetHostFromFakeIP(address);
		}
		catch (Exception e)
		{
			Console.WriteLine($"[IkvmNameService] failed to resolve [{string.Join(", ", addr)}] {e}");
		}
		throw new UnknownHostException();
	}
}

public static class IkvmSocketService
{
	public static void Install()
	{
		Socket.setSocketImplFactory(new EpoxySocketImplFactory());
		HttpsURLConnection.setDefaultSSLSocketFactory(new EpoxySslSocketFactory());
		HttpsURLConnection.setDefaultHostnameVerifier(new AllowAllHostnameVerifier());
	}

	private class AllowAllHostnameVerifier : HostnameVerifier
	{
		public bool verify(string hostname, SSLSession session) => true;
	}

	private class EpoxySocketImplFactory : SocketImplFactory
	{
		public SocketImpl createSocketImpl() => new EpoxySocketImpl();
	}

	private class EpoxyInputStream(WebSocketStream Socket) : java.io.InputStream
	{
		private readonly Lock lck = new();

		public override int read()
		{
			lock (lck)
			{
				return Socket.ReadByte();
			}
		}

		public override int read(byte[] b)
		{
			lock (lck)
			{
				var n = Socket.Read(b);
				return n <= 0 ? -1 : n;
			}
		}

		public override int read(byte[] b, int off, int len)
		{
			if (len == 0) return 0;
			lock (lck)
			{
				var n = Socket.Read(b, off, len);
				return n <= 0 ? -1 : n;
			}
		}
	}
	private class EpoxyOutputStream(WebSocketStream Socket) : java.io.OutputStream
	{
		private readonly Lock lck = new();

		public override void write(int b)
		{
			lock (lck)
			{
				Socket.WriteByte((byte)b);
			}
		}

		public override void write(byte[] b)
		{
			lock (lck)
			{
				Socket.Write(b);
			}
		}

		public override void write(byte[] b, int off, int len)
		{
			lock (lck)
			{
				Socket.Write(b, off, len);
			}
		}
	}

	private class EpoxySocketImpl : SocketImpl
	{
		private string Protocol;
		private WebSocketStream Socket;

		protected override void create(bool stream)
		{
			Protocol = stream ? "wisp-tcp" : "wisp-udp";
		}

		protected override void connect(SocketAddress address, int timeout)
		{
			var (host, port) = IkvmNetworkState.ResolveTarget(address);

			ClientWebSocket socket = new();
			var task = socket.ConnectAsync(new($"ws://{Protocol}/{host}:{port}"), new());
			if (timeout == 0)
			{
				task.Wait();
			}
			else
			{
				if (!task.Wait(TimeSpan.FromMilliseconds(timeout)))
					throw new TimeoutException("connect took too long");
			}

			Socket = new(socket);
		}

		protected override java.io.InputStream getInputStream() => new EpoxyInputStream(Socket);
		protected override java.io.OutputStream getOutputStream() => new EpoxyOutputStream(Socket);
		protected override void close()
		{
			lock (Socket)
			{
				Socket.Close();
			}
		}

		protected override int available() => 0;

		protected override void connect(InetAddress address, int port) => connect(new InetSocketAddress(address, port), 30 * 1000);
		protected override void connect(string host, int port) => connect(new InetSocketAddress(host, port), 30 * 1000);

		public override void setOption(int optID, object value) { /* tunnel has no knobs; ignore */ }
		public override object getOption(int optID) => optID == SocketOptions.SO_TIMEOUT ? 0 : null; // sane defaults
		protected override void sendUrgentData(int data) => throw new NotImplementedException();

		protected override void bind(InetAddress host, int port) => throw new NotImplementedException("no servers");
		protected override void listen(int backlog) => throw new NotImplementedException("no servers");
		protected override void accept(SocketImpl s) => throw new NotImplementedException("no servers");
	}

	private class EpoxySslSocketFactory : SSLSocketFactory
	{
		public override Socket createSocket(InetAddress host, int port) => new EpoxySslSocket(host, port);
		public override Socket createSocket(string host, int port) => createSocket(InetAddress.getByName(host), port);
		public override Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) => createSocket(address, port);
		public override Socket createSocket(string host, int port, InetAddress localHost, int localPort) => createSocket(host, port);
		public override Socket createSocket(Socket existing, string host, int port, bool autoClose)
		{
			// close connection since we cant upgrade
			if (autoClose) existing.close();
			return createSocket(host, port);
		}

		public override string[] getDefaultCipherSuites() => ["TLS_AES_128_GCM_SHA256"];
		public override string[] getSupportedCipherSuites() => getDefaultCipherSuites();
	}

	private class EpoxySslSession(string host, int port) : SSLSession
	{
		private readonly byte[] id = Guid.NewGuid().ToByteArray();
		private readonly long created = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
		private readonly Dictionary<string, object> values = [];

		public byte[] getId() => id;
		public long getCreationTime() => created;
		public long getLastAccessedTime() => created;

		public void putValue(string name, object value) => values[name] = value;
		public object getValue(string name) => values.TryGetValue(name, out var v) ? v : null;
		public void removeValue(string name) => values.Remove(name);
		public string[] getValueNames() => [.. values.Keys];

		public int getPacketBufferSize() => 17 * 1024;
		public int getApplicationBufferSize() => 16 * 1024;

		public string getProtocol() => "TLSv1.3";
		public string getCipherSuite() => "TLS_AES_128_GCM_SHA256";
		public string getPeerHost() => host;
		public int getPeerPort() => port;

		public bool isValid() => true;
		public void invalidate() { }

		public SSLSessionContext getSessionContext() => null;
		public Certificate[] getPeerCertificates() => throw new SSLPeerUnverifiedException("Certificate chain unavailable.");
		public X509Certificate[] getPeerCertificateChain() => throw new SSLPeerUnverifiedException("Certificate chain unavailable.");
		public Principal getPeerPrincipal() => throw new SSLPeerUnverifiedException("Peer principal unavailable.");
		public Certificate[] getLocalCertificates() => null;
		public Principal getLocalPrincipal() => null;
	}

	private class EpoxySslSocket : SSLSocket
	{
		private WebSocketStream Socket;
		private EpoxySslSession Session;

		private void Connect(InetAddress hostAddr, int port)
		{
			var host = IkvmNetworkState.ResolveHost(hostAddr);

			ClientWebSocket socket = new();
			socket.ConnectAsync(new($"ws://wisp-tls/{host}:{port}"), new()).Wait();

			Socket = new(socket);
			Session = new(host, port);
		}

		internal EpoxySslSocket(InetAddress host, int port) => Connect(host, port);
		public override void connect(SocketAddress endpoint)
		{
			var isa = (InetSocketAddress)endpoint;
			Connect(isa.getAddress(), isa.getPort());
		}

        public override void close()
        {
			Socket.Close();
        }

		public override java.io.InputStream getInputStream() => new EpoxyInputStream(Socket);
		public override java.io.OutputStream getOutputStream() => new EpoxyOutputStream(Socket);

        public override SSLSession getSession() => Session;

		public override void addHandshakeCompletedListener(HandshakeCompletedListener listener) => listener.handshakeCompleted(new(this, Session));
		public override void removeHandshakeCompletedListener(HandshakeCompletedListener listener) { }
		public override void startHandshake() { }

        public override bool getEnableSessionCreation() => true;
        public override void setEnableSessionCreation(bool flag) {}

		public override bool getUseClientMode() => true;
        public override void setUseClientMode(bool mode) {}

        public override bool getWantClientAuth() => false;
        public override void setWantClientAuth(bool want) {}
        public override bool getNeedClientAuth() => false;
        public override void setNeedClientAuth(bool need) {}

        public override string[] getSupportedCipherSuites() => ["TLS_AES_128_GCM_SHA256"];
        public override string[] getEnabledCipherSuites() => getSupportedCipherSuites();
        public override void setEnabledCipherSuites(string[] suites) {}

        public override string[] getSupportedProtocols() => ["TLSv1.3"];
        public override string[] getEnabledProtocols() => getSupportedProtocols();
        public override void setEnabledProtocols(string[] protocols) {}
	}
}

internal sealed class ActionRunnable : java.lang.Runnable
{
	private readonly Action Body;
	internal ActionRunnable(Action body) => Body = body;
	public void run() => Body();
}

// Netty channel for the MC game connection. It's push/async: inbound frames are pumped off the
// WebSocket and posted onto the event loop, outbound writes are queued to a serialized send pump.
// The WebSocket itself is wrapped by WebSocketStream (shared with the java.net socket path); this
// channel only ever touches its async ReadAsync/WriteAsync surface (never the blocking one).
public sealed class IkvmWebSocketChannel : io.netty.channel.AbstractChannel
{
	private static readonly io.netty.channel.ChannelMetadata METADATA = new(false);
	private const int MaxReaderStackDepth = 8;

	private readonly io.netty.channel.ChannelConfig Config;
	private readonly java.lang.Runnable ReadTask;
	private readonly Queue<io.netty.buffer.ByteBuf> InboundBuffer = new();

	internal SocketAddress Remote;
	internal SocketAddress Local;

	private WebSocketStream Stream;
	private readonly CancellationTokenSource Life = new();

	// ClientWebSocket forbids concurrent SendAsync, so outbound writes funnel through a single pump.
	private readonly object SendGate = new();
	private readonly Queue<byte[]> SendQueue = new();
	private bool Sending;

	private volatile bool Open = true;
	private volatile bool Active;
	private bool ReadInProgress;
	private int ReaderDepth;

	public IkvmWebSocketChannel() : base(null)
	{
		Config = new io.netty.channel.DefaultChannelConfig(this);
		ReadTask = new ActionRunnable(RunReadTask);
	}

	public override io.netty.channel.ChannelMetadata metadata() => METADATA;
	public override io.netty.channel.ChannelConfig config() => Config;
	public override bool isOpen() => Open;
	public override bool isActive() => Active;

	protected override AbstractUnsafe newUnsafe() => new IkvmWispUnsafe(this);

	// Accept any event loop (Default/Nio/Oio); we drive everything off WebSocket callbacks.
	protected override bool isCompatible(io.netty.channel.EventLoop loop) => true;

	protected override SocketAddress localAddress0() => Local;
	protected override SocketAddress remoteAddress0() => Remote;

	protected override void doBind(SocketAddress local) => Local = local;

	protected override void doDisconnect() => doClose();

	protected override void doClose()
	{
		Active = false;
		Open = false;
		try { Life.Cancel(); } catch { }
		var stream = Stream;
		Stream = null;
		stream?.Abort(); // non-blocking; Close() would do a graceful handshake and stall the loop
		while (InboundBuffer.Count > 0)
		{
			try { InboundBuffer.Dequeue().release(); } catch { }
		}
	}

	protected override void doBeginRead()
	{
		if (ReadInProgress || !Active)
			return;
		if (InboundBuffer.Count == 0)
		{
			ReadInProgress = true;
			return;
		}
		DeliverInbound();
	}

	protected override void doWrite(io.netty.channel.ChannelOutboundBuffer outboundBuffer)
	{
		var stream = Stream;
		for (;;)
		{
			var msg = outboundBuffer.current();
			if (msg == null)
				break;

			if (msg is io.netty.buffer.ByteBuf buf)
			{
				int len = buf.readableBytes();
				if (len > 0 && stream != null)
				{
					var bytes = new byte[len];
					buf.getBytes(buf.readerIndex(), bytes);
					// Handed to the async send pump; the write promise completes optimistically.
					// (No netty-level write backpressure — fine for MC's modest packet volume.)
					Send(bytes);
				}
				outboundBuffer.remove();
			}
			else
			{
				// MC only writes ByteBufs at this stage; reject anything unexpected.
				outboundBuffer.remove(new java.lang.UnsupportedOperationException("unsupported message type"));
			}
		}
	}

	// --- callbacks invoked by the Unsafe / I/O pumps (all run on the event loop) ---

	internal void BeginConnected(ClientWebSocket ws)
	{
		Active = true;
		Stream = new WebSocketStream(ws);
	}

	internal void StartReceiving() => _ = ReceiveLoopAsync();

	private async Task ReceiveLoopAsync()
	{
		var stream = Stream;
		if (stream == null)
			return;

		var buf = new byte[16384];
		try
		{
			while (!Life.IsCancellationRequested)
			{
				int n = await stream.ReadAsync(buf, 0, buf.Length, Life.Token).ConfigureAwait(false);
				if (n <= 0)
				{
					RunOnLoop(OnInboundEof);
					return;
				}

				var chunk = new byte[n];
				Array.Copy(buf, 0, chunk, 0, n);
				RunOnLoop(() => OnInboundBytes(chunk));
			}
		}
		catch (OperationCanceledException) { /* closing */ }
		catch (Exception e) { RunOnLoop(() => OnInboundError(e)); }
	}

	private void Send(byte[] bytes)
	{
		lock (SendGate)
		{
			SendQueue.Enqueue(bytes);
			if (Sending)
				return;
			Sending = true;
		}
		_ = SendPumpAsync();
	}

	private async Task SendPumpAsync()
	{
		try
		{
			while (true)
			{
				byte[] next;
				lock (SendGate)
				{
					if (SendQueue.Count == 0)
					{
						Sending = false;
						return;
					}
					next = SendQueue.Dequeue();
				}

				var stream = Stream;
				if (stream == null)
				{
					lock (SendGate) { Sending = false; }
					return;
				}
				await stream.WriteAsync(next, 0, next.Length, Life.Token).ConfigureAwait(false);
			}
		}
		catch (OperationCanceledException)
		{
			lock (SendGate) { Sending = false; }
		}
		catch (Exception e)
		{
			lock (SendGate) { Sending = false; }
			RunOnLoop(() => OnInboundError(e));
		}
	}

	internal void RunOnLoop(Action action)
	{
		var loop = eventLoop();
		if (loop.inEventLoop())
			action();
		else
			loop.execute(new ActionRunnable(action));
	}

	private void OnInboundBytes(byte[] chunk)
	{
		if (!Active)
			return;
		var buf = Config.getAllocator().buffer(chunk.Length);
		buf.writeBytes(chunk);

		InboundBuffer.Enqueue(buf);
		if (ReadInProgress)
		{
			ReadInProgress = false;
			DeliverInbound();
		}
	}

	private void OnInboundEof()
	{
		if (!Open)
			return;
		var u = @unsafe();
		u.close(u.voidPromise());
	}

	private void OnInboundError(Exception e)
	{
		if (!Open)
			return;
		// Surface the failure to the pipeline, then close (fires channelInactive -> MC disconnect).
		pipeline().fireExceptionCaught(new java.io.IOException(e.Message));
		var u = @unsafe();
		u.close(u.voidPromise());
	}

	private void RunReadTask()
	{
		if (!Active || InboundBuffer.Count == 0)
			return;
		ReadFromBuffer();
	}

	// Bounce off the stack via the event loop if fireChannelRead re-enters us too deeply.
	private void DeliverInbound()
	{
		if (ReaderDepth >= MaxReaderStackDepth)
		{
			eventLoop().execute(ReadTask);
			return;
		}
		ReaderDepth++;
		try { ReadFromBuffer(); }
		finally { ReaderDepth--; }
	}

	private void ReadFromBuffer()
	{
		var handle = @unsafe().recvBufAllocHandle();
		handle.reset(Config);
		var pipe = pipeline();
		do
		{
			if (InboundBuffer.Count == 0)
				break;
			var received = InboundBuffer.Dequeue();
			int n = received.readableBytes();
			handle.attemptedBytesRead(n);
			handle.lastBytesRead(n);
			handle.incMessagesRead(1);
			pipe.fireChannelRead(received);
		}
		while (handle.continueReading());
		handle.readComplete();
		pipe.fireChannelReadComplete();
	}
}

internal sealed class IkvmWispUnsafe : io.netty.channel.AbstractChannel.AbstractUnsafe
{
	private readonly IkvmWebSocketChannel Chan;

	internal IkvmWispUnsafe(IkvmWebSocketChannel chan) : base(chan) => Chan = chan;

	public override void connect(SocketAddress remoteAddress, SocketAddress localAddress, io.netty.channel.ChannelPromise promise)
	{
		if (!promise.setUncancellable() || !ensureOpen(promise))
			return;

		try
		{
			if (localAddress != null)
				Chan.Local = localAddress;
			Chan.Remote = remoteAddress;

			var (host, port) = IkvmNetworkState.ResolveTarget(remoteAddress);
			var uri = new Uri($"ws://wisp-tcp/{host}:{port}");

			var ws = new ClientWebSocket();
			int timeout = Chan.config().getConnectTimeoutMillis();
			var cts = new CancellationTokenSource();
			if (timeout > 0)
				cts.CancelAfter(timeout);

			ws.ConnectAsync(uri, cts.Token).ContinueWith(t =>
			{
				cts.Dispose();
				Chan.RunOnLoop(() => FinishConnect(ws, uri, t, promise));
			}, TaskScheduler.Default);
		}
		catch (Exception e)
		{
			promise.tryFailure(annotateConnectException(new ConnectException(e.Message), remoteAddress));
			closeIfClosed();
		}
	}

	private void FinishConnect(ClientWebSocket ws, Uri uri, Task connectTask, io.netty.channel.ChannelPromise promise)
	{
		if (!Chan.isOpen())
		{
			// Channel was closed while the handshake was in flight.
			try { ws.Abort(); ws.Dispose(); } catch { }
			promise.tryFailure(new java.nio.channels.ClosedChannelException());
			return;
		}

		if (connectTask.IsFaulted || connectTask.IsCanceled)
		{
			try { ws.Abort(); ws.Dispose(); } catch { }
			var reason = connectTask.IsCanceled ? "timed out" : connectTask.Exception?.GetBaseException().Message;
			var cause = new ConnectException($"wisp websocket connect to {uri} failed: {reason}");
			promise.tryFailure(annotateConnectException(cause, Chan.Remote));
			close(voidPromise());
			return;
		}

		bool wasActive = Chan.isActive();
		Chan.BeginConnected(ws);
		bool active = Chan.isActive();
		bool promiseSet = promise.trySuccess();
		if (!wasActive && active)
			Chan.pipeline().fireChannelActive();
		Chan.StartReceiving(); // begin pumping inbound frames only after channelActive
		if (!promiseSet)
			close(voidPromise());
	}
}
