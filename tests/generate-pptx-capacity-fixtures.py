import io, random, sys, zipfile
from pathlib import Path
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
folder=Path(sys.argv[1])
rng=random.Random(948)
deck=Presentation()
deck.slide_width=Inches(13.333)
deck.slide_height=Inches(7.5)
for i in range(32):
    slide=deck.slides.add_slide(deck.slide_layouts[6])
    title=slide.shapes.add_textbox(Inches(.7),Inches(.3),Inches(12),Inches(.7))
    title.text_frame.text=f'隔离性能测试 · 第 {i+1} 页 · 中文图片与图表'
    image=Image.frombytes('RGB',(865,640),rng.randbytes(865*640*3))
    blob=io.BytesIO()
    image.save(blob,format='JPEG',quality=93)
    slide.shapes.add_picture(blob,Inches(.7),Inches(1.35),width=Inches(5.3))
    chart=CategoryChartData()
    chart.categories=['第一组','第二组','第三组']
    chart.add_series('观测一',(2,6,4))
    chart.add_series('观测二',(4,3,5))
    slide.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS,Inches(6.4),Inches(1.6),Inches(6),Inches(4.7),chart)
out=folder/'stress.pptx'
deck.save(out)
print('original',out.stat().st_size)
if out.stat().st_size >= 20*1024*1024:
 raise RuntimeError('reduce fixture JPEG size')
# Pad the HTTP boundary fixture with an unreferenced ZIP entry.
limit=folder/'limit.pptx'
limit.write_bytes(out.read_bytes())
with zipfile.ZipFile(limit,'a',compression=zipfile.ZIP_STORED) as z:
    z.writestr('ppt/media/boundary-padding.bin',b'')
remaining=20*1024*1024-limit.stat().st_size
limit.write_bytes(out.read_bytes())
with zipfile.ZipFile(limit,'a',compression=zipfile.ZIP_STORED) as z:
    z.writestr('ppt/media/boundary-padding.bin',rng.randbytes(remaining))
print('boundary',limit.stat().st_size)
