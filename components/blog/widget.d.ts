declare namespace d3
{
	namespace layout
	{
		function cloud(): CloudLayout;

		interface CloudLayout
		{
			size(size: [number, number]): CloudLayout;
			words(words: Array<{ text: string; size: number; count: number; }>): CloudLayout;
			padding(padding: number): CloudLayout;
			rotate(fn: (d: any, i: number) => number): CloudLayout;
			font(font: string): CloudLayout;
			fontSize(fn: (d: any) => number): CloudLayout;
			on(event: 'end', listener: (words: any[], bounds: any) => void): CloudLayout;
			start(): CloudLayout;
		}
	}
}
