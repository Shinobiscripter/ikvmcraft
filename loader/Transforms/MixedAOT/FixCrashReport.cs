using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

internal class FixCrashReportTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	public static IkvmClassLoaderTransformer Transformer = () => {
		var category = Mappings.CurrentMappings.GetClass("net.minecraft.CrashReportCategory");
		return (category is not null ? new[] { category.Name } : System.Array.Empty<string>(), typeof(FixCrashReportTransform));
	};

	public override void visitEnd()
	{
		var desc = "(Ljava/lang/StackTraceElement;Ljava/lang/StackTraceElement;)Z";
		var category = Mappings.CurrentMappings.GetClass("net.minecraft.CrashReportCategory");
		var validateStackTrace = category?.GetMethod("validateStackTrace", desc);

		var build = methods.toArray().Cast<MethodNode>()
			.FirstOrDefault(x => x.name == validateStackTrace && x.desc == desc);

		// Make the stack-frame getFileName() comparison null-safe (getFileName() may return null).
		// Modern MC (1.21+, incl. 26.2) already uses Objects.equals here, so only rewrite when the
		// NPE-prone String.equals is still present — and never abort class loading if it isn't.
		if (build is not null)
		{
			var c = new JavaCursor(build);
			if (c.TryGotoNext(
					JavaMoveType.After,
					JavaMatch.ALoad(),
					JavaMatch.InvokeVirtual("java/lang/StackTraceElement", "getFileName", "()Ljava/lang/String;"),
					JavaMatch.ALoad(),
					JavaMatch.InvokeVirtual("java/lang/StackTraceElement", "getFileName", "()Ljava/lang/String;"))
				&& c.Next is MethodInsnNode min && min.owner == "java/lang/String" && min.name == "equals")
			{
				c.Remove();
				c.EmitMethod(Opcodes.INVOKESTATIC, "java/util/Objects", "equals", "(Ljava/lang/Object;Ljava/lang/Object;)Z");
			}
		}

		accept(writer);
	}
}
