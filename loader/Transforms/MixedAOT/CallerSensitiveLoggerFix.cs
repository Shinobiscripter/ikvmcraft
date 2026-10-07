using org.objectweb.asm;

// claude'd logmanager pass to make sure loggers everywhere work even when aot frames are skipped
// maybe we should fix stackwalking in aot instead
internal static class CallerSensitiveLoggerFix
{
	private const string LogManager = "org/apache/logging/log4j/LogManager";
	private const string NoArgDesc = "()Lorg/apache/logging/log4j/Logger;";
	private const string ClassArgDesc = "(Ljava/lang/Class;)Lorg/apache/logging/log4j/Logger;";

	// Mojang's LogUtils.getLogger() is also caller-sensitive: it resolves the caller via
	// StackWalker.getCallerClass() and forwards to LoggerFactory.getLogger(Class). Under AOT the
	// stack walk skips frames and throws ArrayIndexOutOfBoundsException, so we bypass it and call
	// LoggerFactory directly with the owning class — exactly what LogUtils would compute on a JVM.
	private const string LogUtils = "com/mojang/logging/LogUtils";
	private const string LoggerFactory = "org/slf4j/LoggerFactory";
	private const string Slf4jNoArgDesc = "()Lorg/slf4j/Logger;";
	private const string Slf4jClassArgDesc = "(Ljava/lang/Class;)Lorg/slf4j/Logger;";

	public static byte[] Apply(byte[] bytes)
	{
		// Cheap reject: only pay for an ASM round-trip when the class actually references one of the
		// caller-sensitive factories (their internal names land in the constant pool verbatim as ASCII UTF-8).
		if (!ContainsAscii(bytes, LogManager) && !ContainsAscii(bytes, LogUtils))
			return bytes;

		var reader = new ClassReader(bytes);
		// COMPUTE_MAXS only: we insert an LDC before an existing invokestatic within a basic block, which
		// can bump max stack by 1 but never adds a frame boundary, so the existing StackMapTable stays
		// valid. (COMPUTE_FRAMES would force loading referenced types — too costly/fragile to do globally.)
		var writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
		reader.accept(new Visitor(writer), 0);
		return writer.toByteArray();
	}

	private sealed class Visitor(ClassVisitor next) : ClassVisitor(Opcodes.ASM9, next)
	{
		private string Owner;

		public override void visit(int version, int access, string name, string signature, string superName, string[] interfaces)
		{
			Owner = name;
			base.visit(version, access, name, signature, superName, interfaces);
		}

		public override MethodVisitor visitMethod(int access, string name, string descriptor, string signature, string[] exceptions)
		{
			var mv = base.visitMethod(access, name, descriptor, signature, exceptions);
			return mv == null ? null : new MethodPatcher(mv, Owner);
		}
	}

	private sealed class MethodPatcher(MethodVisitor next, string Owner) : MethodVisitor(Opcodes.ASM9, next)
	{
		public override void visitMethodInsn(int opcode, string owner, string name, string descriptor, bool isInterface)
		{
			if (opcode == Opcodes.INVOKESTATIC
				&& owner == LogManager
				&& descriptor == NoArgDesc
				&& (name == "getLogger" || name == "getFormatterLogger"))
			{
				// getLogger() -> getLogger(ThisClass.class)
				visitLdcInsn(Type.getObjectType(Owner));
				base.visitMethodInsn(Opcodes.INVOKESTATIC, LogManager, name, ClassArgDesc, false);
				return;
			}
			if (opcode == Opcodes.INVOKESTATIC
				&& owner == LogUtils
				&& name == "getLogger"
				&& descriptor == Slf4jNoArgDesc)
			{
				// LogUtils.getLogger() -> LoggerFactory.getLogger(ThisClass.class)
				visitLdcInsn(Type.getObjectType(Owner));
				base.visitMethodInsn(Opcodes.INVOKESTATIC, LoggerFactory, "getLogger", Slf4jClassArgDesc, false);
				return;
			}
			base.visitMethodInsn(opcode, owner, name, descriptor, isInterface);
		}
	}

	private static bool ContainsAscii(byte[] haystack, string needle)
	{
		int n = needle.Length;
		if (n == 0 || haystack.Length < n)
			return false;
		for (int i = 0; i <= haystack.Length - n; i++)
		{
			int j = 0;
			while (j < n && haystack[i + j] == (byte)needle[j])
				j++;
			if (j == n)
				return true;
		}
		return false;
	}
}
