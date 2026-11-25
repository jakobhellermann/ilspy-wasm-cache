using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;

return;

public static partial class Decompiler
{
    static readonly DecompilerSettings Settings = new();
    static readonly InMemoryResolver Resolver = new();
    static CSharpDecompiler? decompiler;

    [JSExport]
    public static void AddAssembly(string fileName, byte[] bytes) => Resolver.Add(fileName, bytes);

    /// Loads the main assembly; returns the file names of all assemblies its type system resolved, as a JSON array.
    [JSExport]
    public static async Task<string> Load(string mainFileName)
    {
        var main = Resolver.Find(Path.GetFileNameWithoutExtension(mainFileName))
            ?? throw new FileNotFoundException(mainFileName);
        // the synchronous CSharpDecompiler constructors block on a task, which single-threaded wasm cannot do
        var typeSystem = await DecompilerTypeSystem.CreateAsync(main, Resolver, Settings);
        decompiler = new CSharpDecompiler(typeSystem, Settings);
        var used = typeSystem.Modules
            .Select(m => m.MetadataFile?.FileName)
            .OfType<string>()
            .ToArray();
        return JsonSerializer.Serialize(used, Json.Default.StringArray);
    }

    /// Returns `{ source, members: [{ name, line }] }` as JSON; `line` is 1-based.
    [JSExport]
    public static string DecompileType(string fullName)
    {
        if (decompiler is null) throw new InvalidOperationException("no assembly loaded");
        var tree = decompiler.DecompileType(new FullTypeName(fullName));
        var writer = new StringWriter();
        tree.AcceptVisitor(new CSharpOutputVisitor(
            TokenWriter.CreateWriterThatSetsLocationsInAST(writer), Settings.CSharpFormattingOptions));
        var members = tree.Descendants.SelectMany(MembersOf).ToArray();
        return JsonSerializer.Serialize(new DecompiledType(writer.ToString(), members), Json.Default.DecompiledType);
    }

    static IEnumerable<Member> MembersOf(AstNode node) => node switch
    {
        Accessor => [],
        // `int a, b;` declares several members in one node
        FieldDeclaration f => f.Variables.Select(v => new Member(v.Name, v.StartLocation.Line)),
        EventDeclaration e => e.Variables.Select(v => new Member(v.Name, v.StartLocation.Line)),
        EntityDeclaration d => [new Member(d.Name, (d.NameToken?.StartLocation ?? d.StartLocation).Line)],
        _ => [],
    };
}

/// Resolves references by simple assembly name; unresolvable ones degrade the output instead of failing.
sealed class InMemoryResolver : IAssemblyResolver
{
    readonly Dictionary<string, (string FileName, byte[] Bytes)> files = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, PEFile> opened = new(StringComparer.OrdinalIgnoreCase);

    public void Add(string fileName, byte[] bytes) => files[Path.GetFileNameWithoutExtension(fileName)] = (fileName, bytes);

    public PEFile? Find(string name)
    {
        if (opened.TryGetValue(name, out var file)) return file;
        if (!files.TryGetValue(name, out var f)) return null;
        return opened[name] = new PEFile(f.FileName, new MemoryStream(f.Bytes));
    }

    public MetadataFile? Resolve(IAssemblyReference reference) => Find(reference.Name);
    public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => Find(Path.GetFileNameWithoutExtension(moduleName));
    public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
    public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult(ResolveModule(mainModule, moduleName));
    public IDisposable? BeginSnapshot() => null;
}

public record Member(string Name, int Line);

public record DecompiledType(string Source, Member[] Members);

[System.Text.Json.Serialization.JsonSourceGenerationOptions(PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase)]
[System.Text.Json.Serialization.JsonSerializable(typeof(DecompiledType))]
[System.Text.Json.Serialization.JsonSerializable(typeof(string[]))]
internal partial class Json : System.Text.Json.Serialization.JsonSerializerContext;
