using System;
using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.TextureAtlas
{
    /// <summary>
    /// Pure bin-packing for texture atlases. No Unity asset operations — outputs only UV rects.
    /// Extracted from MB2_TexturePackerRegular (single-atlas path only).
    /// Uses a Guillotine binary-tree split algorithm with iterative size probing.
    /// Expects power-of-two source textures; use ValidatePowerOfTwo to check inputs.
    /// </summary>
    public static class TextureAtlasPacker
    {
        /// <summary>Returns true if n is a positive power of two.</summary>
        public static bool IsPowerOfTwo(int n) => n > 0 && (n & (n - 1)) == 0;

        /// <summary>
        /// Logs an error for every texture size that is not power-of-two.
        /// Returns true if all sizes are valid.
        /// </summary>
        public static bool ValidatePowerOfTwo(IList<Vector2Int> textureSizes)
        {
            bool valid = true;
            for (int i = 0; i < textureSizes.Count; i++)
            {
                bool wOk = IsPowerOfTwo(textureSizes[i].x);
                bool hOk = IsPowerOfTwo(textureSizes[i].y);
                if (!wOk || !hOk)
                {
                    Debug.LogError($"[TextureAtlasPacker] Texture {i} size {textureSizes[i]} is not power-of-two.");
                    valid = false;
                }
            }
            return valid;
        }

        /// <summary>
        /// Packs the given texture sizes into a single atlas and returns the layout.
        /// Source textures are expected to be power-of-two; call ValidatePowerOfTwo first.
        /// With POT textures, padding=0 is safe — atlas UV boundaries align on exact texel boundaries.
        /// </summary>
        /// <param name="textureSizes">Pixel dimensions of each source texture (should be POT).</param>
        /// <param name="maxAtlasWidth">Maximum atlas width in pixels.</param>
        /// <param name="maxAtlasHeight">Maximum atlas height in pixels.</param>
        /// <param name="padding">Pixels of border padding per texture. 0 is correct for POT inputs.</param>
        /// <param name="powerOfTwo">Whether to constrain atlas dimensions to powers of two.</param>
        /// <returns>Layout with normalized UV rects, or null if packing fails.</returns>
        public static TextureAtlasLayout Pack(
            IList<Vector2Int> textureSizes,
            int maxAtlasWidth = 4096,
            int maxAtlasHeight = 4096,
            int padding = 0,
            bool powerOfTwo = true)
        {
            if (textureSizes == null || textureSizes.Count == 0)
                return new TextureAtlasLayout
                {
                    AtlasWidth = 0,
                    AtlasHeight = 0,
                    UVRects = new Rect[0],
                    SourceIndices = new int[0]
                    //Padding = padding
                };

            ValidatePowerOfTwo(textureSizes);

            return new PackerImpl(powerOfTwo).Pack(textureSizes, maxAtlasWidth, maxAtlasHeight, padding);
        }

        // -------------------------------------------------------------------------
        // Private implementation — holds mutable state across recursive calls
        // -------------------------------------------------------------------------

        private class PackerImpl
        {
            private const int MAX_RECURSION_DEPTH = 10;

            private readonly bool _powerOfTwo;
            private ProbeResult _bestRoot;

            internal PackerImpl(bool powerOfTwo) { _powerOfTwo = powerOfTwo; }

            // -- Data types -------------------------------------------------------

            private class PixRect
            {
                public int x, y, w, h;
                public PixRect() { }
                public PixRect(int x, int y, int w, int h) { this.x = x; this.y = y; this.w = w; this.h = h; }
                public override string ToString() => $"x={x},y={y},w={w},h={h}";
            }

            private class Image
            {
                public int imgId;
                public int w, h, x, y;

                // w/h include padding on both sides; clamped to a minimum size.
                public Image(int id, int tw, int th, int pad, int minW, int minH)
                {
                    imgId = id;
                    w = Math.Max(tw + pad * 2, minW);
                    h = Math.Max(th + pad * 2, minH);
                }
            }

            // Binary-tree node (Guillotine split).
            private class Node
            {
                internal Node[] child = new Node[2];
                internal PixRect r;
                internal Image img;

                internal Node Insert(Image im, bool handed)
                {
                    int a = handed ? 0 : 1;
                    int b = handed ? 1 : 0;

                    // Non-leaf: try children
                    if (child[0] != null && child[1] != null)
                    {
                        Node n = child[a].Insert(im, handed);
                        return n ?? child[b].Insert(im, handed);
                    }

                    // Leaf: occupied
                    if (img != null) return null;

                    // Too small
                    if (r.w < im.w || r.h < im.h) return null;

                    // Perfect fit
                    if (r.w == im.w && r.h == im.h) { img = im; return this; }

                    // Split and recurse
                    child[a] = new Node();
                    child[b] = new Node();

                    int dw = r.w - im.w;
                    int dh = r.h - im.h;

                    if (dw > dh)
                    {
                        child[a].r = new PixRect(r.x, r.y, im.w, r.h);
                        child[b].r = new PixRect(r.x + im.w, r.y, r.w - im.w, r.h);
                    }
                    else
                    {
                        child[a].r = new PixRect(r.x, r.y, r.w, im.h);
                        child[b].r = new PixRect(r.x, r.y + im.h, r.w, r.h - im.h);
                    }

                    return child[a].Insert(im, handed);
                }
            }

            private class ProbeResult
            {
                public int w, h, outW, outH;
                public Node root;
                public bool fitsInMaxDim;
                public float efficiency, squareness;

                public void Set(int w, int h, int outW, int outH, Node root, bool fits, float e, float sq)
                {
                    this.w = w; this.h = h; this.outW = outW; this.outH = outH;
                    this.root = root; fitsInMaxDim = fits; efficiency = e; squareness = sq;
                }

                public float GetScore(bool pow2)
                {
                    float fitsScore = fitsInMaxDim ? 1f : 0f;
                    return pow2 ? fitsScore * 2f + efficiency : squareness + 2f * efficiency + fitsScore;
                }
            }

            // -- Comparers --------------------------------------------------------

            private class ImgIDComparer : IComparer<Image>
            {
                public int Compare(Image x, Image y) => x.imgId.CompareTo(y.imgId);
            }

            private class ImageHeightComparer : IComparer<Image>
            {
                public int Compare(Image x, Image y) => y.h.CompareTo(x.h); // descending
            }

            private class ImageWidthComparer : IComparer<Image>
            {
                public int Compare(Image x, Image y) => y.w.CompareTo(x.w); // descending
            }

            private class ImageAreaComparer : IComparer<Image>
            {
                public int Compare(Image x, Image y) => (y.w * y.h).CompareTo(x.w * x.h); // descending
            }

            // -- Math helpers -----------------------------------------------------

            private static int RoundToNearestPositivePowerOfTwo(int x)
            {
                int p = (int)Mathf.Pow(2, Mathf.RoundToInt(Mathf.Log(x) / Mathf.Log(2)));
                return p <= 1 ? 2 : p;
            }

            private static int CeilToNearestPowerOfTwo(int x)
            {
                int p = (int)Mathf.Pow(2, Mathf.Ceil(Mathf.Log(x) / Mathf.Log(2)));
                return p <= 1 ? 2 : p;
            }

            // -- Tree helpers -----------------------------------------------------

            private void GetExtent(Node node, ref int x, ref int y)
            {
                if (node.img != null)
                {
                    if (node.r.x + node.img.w > x) x = node.r.x + node.img.w;
                    if (node.r.y + node.img.h > y) y = node.r.y + node.img.h;
                }
                if (node.child[0] != null) GetExtent(node.child[0], ref x, ref y);
                if (node.child[1] != null) GetExtent(node.child[1], ref x, ref y);
            }

            private static void FlattenTree(Node node, List<Image> result)
            {
                if (node.img != null)
                {
                    node.img.x = node.r.x;
                    node.img.y = node.r.y;
                    result.Add(node.img);
                }
                if (node.child[0] != null) FlattenTree(node.child[0], result);
                if (node.child[1] != null) FlattenTree(node.child[1], result);
            }

            // -- Atlas size stepping ----------------------------------------------

            private int StepWidthHeight(int oldVal, int step, int maxDim)
            {
                if (_powerOfTwo && oldVal < maxDim) return oldVal * 2;
                int newVal = oldVal + step;
                if (newVal > maxDim && oldVal < maxDim) newVal = maxDim;
                return newVal;
            }

            // -- Probe a single atlas size ----------------------------------------

            private bool ProbeSingleAtlas(Image[] imgs, int idealW, int idealH,
                float imgArea, int maxW, int maxH, ProbeResult pr)
            {
                var root = new Node { r = new PixRect(0, 0, idealW, idealH) };

                for (int i = 0; i < imgs.Length; i++)
                {
                    Node n = root.Insert(imgs[i], false);
                    if (n == null) return false;

                    if (i == imgs.Length - 1)
                    {
                        int usedW = 0, usedH = 0;
                        GetExtent(root, ref usedW, ref usedH);

                        int atlasW = usedW, atlasH = usedH;
                        float efficiency, squareness;
                        bool fits;

                        if (_powerOfTwo)
                        {
                            atlasW = Mathf.Min(CeilToNearestPowerOfTwo(usedW), maxW);
                            atlasH = Mathf.Min(CeilToNearestPowerOfTwo(usedH), maxH);
                            if (atlasH < atlasW / 2) atlasH = atlasW / 2;
                            if (atlasW < atlasH / 2) atlasW = atlasH / 2;
                            fits = usedW <= maxW && usedH <= maxH;
                            float scaleW = Mathf.Max(1f, (float)usedW / maxW);
                            float scaleH = Mathf.Max(1f, (float)usedH / maxH);
                            float area = atlasW * scaleW * atlasH * scaleH;
                            efficiency = 1f - (area - imgArea) / area;
                            squareness = 1f;
                        }
                        else
                        {
                            efficiency = 1f - (usedW * usedH - imgArea) / (usedW * usedH);
                            squareness = usedW < usedH ? (float)usedW / usedH : (float)usedH / usedW;
                            fits = usedW <= maxW && usedH <= maxH;
                        }

                        pr.Set(usedW, usedH, atlasW, atlasH, root, fits, efficiency, squareness);
                        return true;
                    }
                }

                Debug.LogError("[TextureAtlasPacker] ProbeSingleAtlas reached unreachable code.");
                return false;
            }

            // -- Scale the packed result to fit maxDim if it overflows ------------

            private bool ScaleAtlasToFitMaxDim(
                Vector2 rootWH, List<Image> images,
                int maxW, int maxH, int pad,
                int minSizeX, int minSizeY, int masterSizeX, int masterSizeY,
                ref int outW, ref int outH,
                out float padX, out float padY,
                out int newMinSizeX, out int newMinSizeY)
            {
                newMinSizeX = minSizeX;
                newMinSizeY = minSizeY;
                bool redo = false;

                padX = (float)pad / outW;
                if (rootWH.x > maxW)
                {
                    padX = (float)pad / maxW;
                    float scale = (float)maxW / rootWH.x;
                    for (int i = 0; i < images.Count; i++)
                    {
                        Image im = images[i];
                        if (im.w * scale < masterSizeX)
                        {
                            redo = true;
                            newMinSizeX = Mathf.CeilToInt(minSizeX / scale);
                        }
                        int right = (int)((im.x + im.w) * scale);
                        im.x = (int)(scale * im.x);
                        im.w = right - im.x;
                    }
                    outW = maxW;
                }

                padY = (float)pad / outH;
                if (rootWH.y > maxH)
                {
                    padY = (float)pad / maxH;
                    float scale = (float)maxH / rootWH.y;
                    for (int i = 0; i < images.Count; i++)
                    {
                        Image im = images[i];
                        if (im.h * scale < masterSizeY)
                        {
                            redo = true;
                            newMinSizeY = Mathf.CeilToInt(minSizeY / scale);
                        }
                        int bottom = (int)((im.y + im.h) * scale);
                        im.y = (int)(scale * im.y);
                        im.h = bottom - im.y;
                    }
                    outH = maxH;
                }

                return redo;
            }

            // -- Public entry point -----------------------------------------------

            internal TextureAtlasLayout Pack(IList<Vector2Int> sizes, int maxW, int maxH, int padding)
            {
                // With padding=0, allow 1x1 textures. With padding>0, each slot must be at least
                // 2 pixels wide/tall plus the padding on both sides so bleed has a valid source pixel.
                int minSize = padding > 0 ? 2 + padding * 2 : 1;
                return PackImpl(sizes, maxW, maxH, padding, minSize, minSize, minSize, minSize, 0);
            }

            // -- Recursive packing implementation ---------------------------------

            private TextureAtlasLayout PackImpl(
                IList<Vector2Int> sizes, int maxW, int maxH, int padding,
                int minSizeX, int minSizeY, int masterSizeX, int masterSizeY, int depth)
            {
                if (depth > MAX_RECURSION_DEPTH)
                    Debug.LogWarning("[TextureAtlasPacker] Maximum recursion depth reached. Atlas may not be optimal.");

                // Build Image array (includes padding in dimensions)
                float area = 0;
                int maxImgW = 0, maxImgH = 0;
                var imgs = new Image[sizes.Count];
                for (int i = 0; i < imgs.Length; i++)
                {
                    imgs[i] = new Image(i, sizes[i].x, sizes[i].y, padding, minSizeX, minSizeY);
                    area += imgs[i].w * imgs[i].h;
                    maxImgW = Math.Max(maxImgW, imgs[i].w);
                    maxImgH = Math.Max(maxImgH, imgs[i].h);
                }

                // Sort images: tallest-first, widest-first, or largest-area-first
                float ratio = maxImgW > 0 ? (float)maxImgH / maxImgW : 1f;
                if (ratio > 2f)       Array.Sort(imgs, new ImageHeightComparer());
                else if (ratio < 0.5f) Array.Sort(imgs, new ImageWidthComparer());
                else                   Array.Sort(imgs, new ImageAreaComparer());

                // Determine starting atlas dimensions
                int sqrtArea = (int)Mathf.Sqrt(area);
                int idealW, idealH;

                if (_powerOfTwo)
                {
                    idealW = idealH = RoundToNearestPositivePowerOfTwo(sqrtArea);
                    if (maxImgW > idealW) idealW = CeilToNearestPowerOfTwo(idealW);
                    if (maxImgH > idealH) idealH = CeilToNearestPowerOfTwo(idealH);
                }
                else
                {
                    idealW = idealH = sqrtArea;
                    if (maxImgW > sqrtArea) { idealW = maxImgW; idealH = Math.Max(Mathf.CeilToInt(area / maxImgW), maxImgH); }
                    if (maxImgH > sqrtArea) { idealW = Math.Max(Mathf.CeilToInt(area / maxImgH), maxImgW); idealH = maxImgH; }
                }

                if (idealW == 0) idealW = 4;
                if (idealH == 0) idealH = 4;

                int stepW = Math.Max(1, (int)(idealW * 0.15f));
                int stepH = Math.Max(1, (int)(idealH * 0.15f));

                // Probe increasing atlas sizes until a packing is found
                int numWIter = 2;
                int steppedH = idealH;

                while (numWIter >= 1 && steppedH < sqrtArea * 1000)
                {
                    bool successW = false;
                    numWIter = 0;
                    int steppedW = idealW;

                    while (!successW && steppedW < sqrtArea * 1000)
                    {
                        var pr = new ProbeResult();
                        if (ProbeSingleAtlas(imgs, steppedW, steppedH, area, maxW, maxH, pr))
                        {
                            successW = true;
                            if (_bestRoot == null || pr.GetScore(_powerOfTwo) > _bestRoot.GetScore(_powerOfTwo))
                                _bestRoot = pr;
                        }
                        else
                        {
                            numWIter++;
                            steppedW = StepWidthHeight(steppedW, stepW, maxW);
                        }
                    }

                    steppedH = StepWidthHeight(steppedH, stepH, maxH);
                }

                if (_bestRoot == null)
                {
                    Debug.LogError("[TextureAtlasPacker] Failed to find a valid packing.");
                    return null;
                }

                // Compute output dimensions
                int outW, outH;
                if (_powerOfTwo)
                {
                    outW = Mathf.Min(CeilToNearestPowerOfTwo(_bestRoot.w), maxW);
                    outH = Mathf.Min(CeilToNearestPowerOfTwo(_bestRoot.h), maxH);
                    if (outH < outW / 2) outH = outW / 2;
                    if (outW < outH / 2) outW = outH / 2;
                }
                else
                {
                    outW = Mathf.Min(_bestRoot.w, maxW);
                    outH = Mathf.Min(_bestRoot.h, maxH);
                }

                _bestRoot.outW = outW;
                _bestRoot.outH = outH;

                // Flatten tree and sort by original image index
                var images = new List<Image>();
                FlattenTree(_bestRoot.root, images);
                images.Sort(new ImgIDComparer());

                // Scale down if the packed result overflows the max dimensions
                float padX, padY;
                int newMinSizeX, newMinSizeY;
                bool needsRedo = ScaleAtlasToFitMaxDim(
                    new Vector2(_bestRoot.w, _bestRoot.h),
                    images, maxW, maxH, padding,
                    minSizeX, minSizeY, masterSizeX, masterSizeY,
                    ref outW, ref outH,
                    out padX, out padY,
                    out newMinSizeX, out newMinSizeY);

                if (!needsRedo || depth > MAX_RECURSION_DEPTH)
                {
                    // Build final layout — rects are content-area only (padding stripped)
                    var layout = new TextureAtlasLayout
                    {
                        AtlasWidth = outW,
                        AtlasHeight = outH,
                        UVRects = new Rect[images.Count],
                        SourceIndices = new int[images.Count]
                        //Padding = padding
                    };

                    for (int i = 0; i < images.Count; i++)
                    {
                        Image im = images[i];
                        // padX = padding/outW, so (im.x/outW + padX) = (im.x + padding)/outW
                        layout.UVRects[i] = new Rect(
                            (float)im.x / outW + padX,
                            (float)im.y / outH + padY,
                            (float)im.w / outW - padX * 2f,
                            (float)im.h / outH - padY * 2f);
                        layout.SourceIndices[i] = im.imgId;
                    }

                    return layout;
                }
                else
                {
                    // Redo packing with larger minimum image sizes to avoid vanishing thin images
                    _bestRoot = null;
                    return PackImpl(sizes, maxW, maxH, padding,
                        newMinSizeX, newMinSizeY, masterSizeX, masterSizeY, depth + 1);
                }
            }
        }
    }
}
