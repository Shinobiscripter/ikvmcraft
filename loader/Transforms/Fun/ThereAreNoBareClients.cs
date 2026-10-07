using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

internal class ThereAreNoBareClientsTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	// The crash-report witty comment (getErrorComment) lived on net.minecraft.CrashReport until 1.21,
	// when crash/debug reports were unified and it moved to the net.minecraft.ReportType record. Target
	// whichever exists so this works across versions (and unobfuscated 26.2+).
	private static IClassMapping TargetClass()
		=> Mappings.CurrentMappings.GetClass("net.minecraft.ReportType")
		?? Mappings.CurrentMappings.GetClass("net.minecraft.CrashReport");

	public static IkvmClassLoaderTransformer Transformer = () => {
		var klass = TargetClass();
		return (klass is not null ? new[] { klass.Name } : System.Array.Empty<string>(), typeof(ThereAreNoBareClientsTransform));
	};

	public override void visitEnd()
	{
		var target = TargetClass();
		var errorComment = target?.GetMethod("getErrorComment", "()Ljava/lang/String;");

		// Cosmetic transform: if the method has moved/renamed again, skip rather than abort class loading.
		var build = methods.toArray().Cast<MethodNode>()
			.FirstOrDefault(x => x.name == errorComment && x.desc == "()Ljava/lang/String;");

		if (build is not null)
		{
			var c = new JavaCursor(build);
			c.EmitLdc("there are no bare clients");
			c.EmitAReturn();
		}

		accept(writer);
	}
}
