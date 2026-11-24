"""Generate complete OOXML test decks without copying anyone's private files."""
import io
import json
from pathlib import Path
import sys
import zipfile
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
picture = Image.new('RGB', (1024, 640), '#f1cb71')
draw = ImageDraw.Draw(picture)
draw.rectangle((30, 30, 990, 600), fill='#277a81')
draw.ellipse((270, 90, 750, 550), fill='#d04b50')
draw.polygon([(180, 470), (360, 230), (540, 490)], fill='#284362')
picture.save(folder / 'sample.png')

def caption(slide, text, x, y, w, size, font='Noto Sans SC', color='223955'):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(.65))
    p = box.text_frame.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.name = font
    run.font.color.rgb = RGBColor.from_string(color)
    return box

manifest = []
for i in range(20):
    deck = Presentation()
    width, height = [(13.333, 7.5), (10, 7.5), (7.5, 10), (12, 6)][i % 4]
    deck.slide_width, deck.slide_height = Inches(width), Inches(height)
    expected = []
    for page in range(2 + i % 3):
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = RGBColor.from_string('F5F1E8')
        label = f'样本 {i+1:02d} · 第 {page+1} 页'
        caption(slide, label, .42, .26, width-.8, 23,
                'PPT Fixture Unavailable Font' if i % 5 == 0 else 'Noto Sans SC')
        caption(slide, '清华汇报 · 中文换行与字形', .42, 1.0, width-.8, 17)
        mode = (i + page) % 5
        if mode == 0:
            photo = slide.shapes.add_picture(str(folder / 'sample.png'), Inches(.55), Inches(2), width=Inches(width*.58))
            photo.crop_left = .1
            photo.rotation = -7
            feature = 'image'
        elif mode == 1:
            table = slide.shapes.add_table(3, 3, Inches(.5), Inches(2), Inches(width-.95), Inches(2.5)).table
            table.cell(0, 0).merge(table.cell(0, 1))
            table.cell(0, 0).text = '区域 · 汇总'
            table.cell(1, 0).text = '月份'
            table.cell(1, 1).text = '数据'
            table.cell(2, 0).text = '十一月'
            table.cell(2, 1).text = '73'
            table.cell(1, 1).fill.solid()
            table.cell(1, 1).fill.fore_color.rgb = RGBColor.from_string('F1CB71')
            feature = 'table'
        elif mode in (2, 3):
            data = CategoryChartData()
            data.categories = ['东台', '上海', '北京']
            data.add_series('示例', (8, 3, 5))
            if mode == 3:
                data.add_series('对照', (5, 6, 2))
            kind = XL_CHART_TYPE.PIE if mode == 2 and i % 2 == 0 else XL_CHART_TYPE.COLUMN_CLUSTERED if mode == 2 else XL_CHART_TYPE.LINE_MARKERS
            chart = slide.shapes.add_chart(kind, Inches(.55), Inches(1.8), Inches(width-1.1), Inches(height*.51), data).chart
            chart.has_legend = True
            feature = 'chart'
        else:
            group = slide.shapes.add_group_shape()
            for number, name in enumerate((MSO_SHAPE.CHEVRON, MSO_SHAPE.STAR_12_POINT, MSO_SHAPE.BENT_ARROW)):
                shape = group.shapes.add_shape(name, Inches(.6 + number*width*.23), Inches(2+number*.18), Inches(width*.22), Inches(1.35))
                shape.rotation = number*12
                shape.fill.solid()
                shape.fill.fore_color.rgb = RGBColor.from_string(('277A81','D04B50','F1CB71')[number])
                shape.line.color.rgb = RGBColor.from_string('223955')
            group.rotation = 10
            feature = 'shape'
        expected.append({'label': label, 'feature': feature})
    path = folder / f'deck-{i+1:02d}.pptx'
    deck.save(path)
    manifest.append({'name': path.name, 'ratio': width / height, 'pages': expected})
ole = Presentation(folder / 'deck-01.pptx')
ole.slides[1].shapes.add_ole_object(io.BytesIO(b'Embedded sample payload'), 'Package',
                                  Inches(.6), Inches(5.0), Inches(1.2), Inches(.8))
ole.save(folder / 'unsupported-ole.pptx')
mixed = Presentation()
for kind in (XL_CHART_TYPE.COLUMN_CLUSTERED, XL_CHART_TYPE.RADAR):
    slide = mixed.slides.add_slide(mixed.slide_layouts[6])
    caption(slide, '两页的图表支持范围不同', .4, .3, 8, 24)
    series = CategoryChartData()
    series.categories = ['甲', '乙', '丙']
    series.add_series('来源一', (3, 7, 4))
    series.add_series('来源二', (6, 4, 5))
    slide.shapes.add_chart(kind, Inches(.6), Inches(1.2), Inches(8), Inches(4.5), series)
mixed.save(folder / 'mixed-charts.pptx')
with zipfile.ZipFile(folder / 'deck-01.pptx') as source, zipfile.ZipFile(folder / 'reordered.pptx', 'w', zipfile.ZIP_DEFLATED) as target:
    from lxml import etree
    for member in source.namelist():
        content = source.read(member)
        if member == 'ppt/presentation.xml':
            tree = etree.fromstring(content)
            slide_list = tree.find('{http://schemas.openxmlformats.org/presentationml/2006/main}sldIdLst')
            slide_list.append(slide_list[0])
            content = etree.tostring(tree, encoding='UTF-8', xml_declaration=True)
        target.writestr(member, content)
with zipfile.ZipFile(folder / 'deck-01.pptx') as source, zipfile.ZipFile(folder / 'expanded-limit.pptx', 'w', zipfile.ZIP_DEFLATED) as target:
    for member in source.namelist():
        target.writestr(member, source.read(member))
    with target.open('ppt/media/oversized.bin', 'w') as item:
        for _ in range(34):
            item.write(bytes(1024*1024))
(folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
